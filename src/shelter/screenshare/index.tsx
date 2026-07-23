import type { Node } from "@vencord/venmic";
import { patchNavigator, ScreensharePicker } from "./components/ScreensharePicker.jsx";
import type { IPCSources } from "./components/SourceCard.jsx";

const {
    util: { log },
    flux: {
        stores: { UserStore, MediaEngineStore },
        dispatcher,
        intercept,
    },
    ui: { openModal },
    plugin: { store },
} = shelter;

store.fps ??= 30; // set default
store.resolution ??= 1080; // 1080p is a safer default than 2K while OpenH264 is in use

const BITRATE_CEILING = 25_000_000;

/** Discord-like Go Live targets (bits/s) by height and fps band. */
function targetBitrateFor(height: number, fps: number): number {
    const highFps = fps > 30;
    const table: Record<number, [number, number]> = {
        480: [2_500_000, 3_500_000],
        720: [4_000_000, 6_000_000],
        1080: [8_000_000, 10_000_000],
        1440: [12_000_000, 15_000_000],
        2160: [18_000_000, 25_000_000],
    };
    const nearest = Object.keys(table)
        .map(Number)
        .sort((a, b) => Math.abs(a - height) - Math.abs(b - height))[0];
    const [low, high] = table[nearest] ?? [4_000_000, 6_000_000];
    return Math.min(highFps ? high : low, BITRATE_CEILING);
}

let loggedEncoderForCurrentStream = false;

function getOutboundVideoSender(streamConnection: {
    pc?: RTCPeerConnection;
    peerConnection?: RTCPeerConnection;
    _pc?: RTCPeerConnection;
}): RTCRtpSender | undefined {
    const pc = streamConnection.pc ?? streamConnection.peerConnection ?? streamConnection._pc;
    return pc?.getSenders?.().find((s) => s.track?.kind === "video");
}

/** Prefer H.264 profiles that map to VideoToolbox HW encode (not OpenH264 CBP). */
function preferMacVideoToolboxH264(streamConnection: {
    pc?: RTCPeerConnection;
    peerConnection?: RTCPeerConnection;
    _pc?: RTCPeerConnection;
}): void {
    if (window.legcord.platform !== "darwin") return;
    try {
        const sender = getOutboundVideoSender(streamConnection);
        if (!sender?.setCodecPreferences || typeof RTCRtpSender.getCapabilities !== "function") return;

        const caps = RTCRtpSender.getCapabilities("video");
        if (!caps?.codecs?.length) return;

        const rank = (codec: RTCRtpCodec) => {
            const mime = codec.mimeType.toLowerCase();
            const fmtp = (codec.sdpFmtpLine ?? "").toLowerCase();
            if (!mime.includes("h264")) {
                if (mime.includes("vp9")) return 10;
                if (mime.includes("vp8")) return 11;
                return 20;
            }
            // Avoid Constrained Baseline → OpenH264 software path
            if (/profile-level-id=42e0/.test(fmtp)) return 5;
            if (/profile-level-id=4200/.test(fmtp)) return 0; // Baseline → VideoToolbox
            if (/profile-level-id=4d00/.test(fmtp)) return 1; // Main
            if (/profile-level-id=6400/.test(fmtp)) return 2; // High
            return 3;
        };

        const preferred = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
        sender.setCodecPreferences(preferred);
        log(
            `Preferred macOS VideoToolbox H264 codecs: ${preferred
                .slice(0, 6)
                .map((c) => `${c.mimeType}${c.sdpFmtpLine ? ` (${c.sdpFmtpLine})` : ""}`)
                .join(", ")}`,
        );
    } catch (e) {
        console.warn("[Screenshare] Failed to prefer VideoToolbox H264:", e);
    }
}

/** Cap RTP framerate / bitrate ceiling without forcing scale (Discord adapts spatial layers). */
async function applySenderEncodeLimits(
    streamConnection: {
        pc?: RTCPeerConnection;
        peerConnection?: RTCPeerConnection;
        _pc?: RTCPeerConnection;
    },
    _height: number,
    fps: number,
    maxBitrate: number,
): Promise<void> {
    try {
        const sender = getOutboundVideoSender(streamConnection);
        if (!sender?.getParameters || !sender.setParameters) return;

        const params = sender.getParameters();
        if (!params.encodings?.length) {
            params.encodings = [{}];
        }

        for (const encoding of params.encodings) {
            // Only raise Chromium's default ~2.5Mbps ceiling — never fight adaptive downscales
            const current = encoding.maxBitrate;
            if (current == null || current === 0 || (current >= 2_000_000 && current <= 2_500_000)) {
                encoding.maxBitrate = maxBitrate;
            }
            encoding.maxFramerate = fps;
            // Do not set scaleResolutionDownBy — it fought Discord BWE and crushed quality to 320–640p
        }

        await sender.setParameters(params);
        log(
            `Applied RTP sender limits: maxBitrate ceiling≈${(maxBitrate / 1_000_000).toFixed(1)}Mbps maxFramerate=${fps}`,
        );
    } catch (e) {
        console.warn("[Screenshare] Failed to apply RTP sender encode limits:", e);
    }
}

async function logEncoderImplementation(streamConnection: {
    pc?: RTCPeerConnection;
    peerConnection?: RTCPeerConnection;
    _pc?: RTCPeerConnection;
}): Promise<void> {
    try {
        const sender = getOutboundVideoSender(streamConnection);
        if (!sender?.getStats) return;

        // Encoder stats appear shortly after the stream starts
        await new Promise((r) => setTimeout(r, 1500));
        const stats = await sender.getStats();
        for (const report of stats.values()) {
            if (report.type !== "outbound-rtp" || report.kind !== "video") continue;
            const impl = "encoderImplementation" in report ? String(report.encoderImplementation) : "unknown";
            const mime = "mimeType" in report ? String(report.mimeType) : "unknown";
            const scale =
                "scalabilityMode" in report
                    ? String(report.scalabilityMode)
                    : "frameWidth" in report && "frameHeight" in report
                      ? `${report.frameWidth}x${report.frameHeight}`
                      : "";
            log(`Screenshare encoder: implementation=${impl} codec=${mime} ${scale}`.trim());
            return;
        }
        log("Screenshare encoder: no outbound-rtp video stats yet");
    } catch (e) {
        console.warn("[Screenshare] Failed to read encoder stats:", e);
    }
}

function onStreamQualityChange() {
    // @ts-expect-error fix types
    const mediaConnections = [...MediaEngineStore.getMediaEngine().connections];
    // @ts-expect-error fix types
    const currentUserId = UserStore.getCurrentUser().id;

    const width = Math.round(store.resolution * (16 / 9));
    const height = store.resolution;
    const targetBitrate = targetBitrateFor(height, store.fps);
    const bitrateMin = Math.round(targetBitrate * 0.8);
    const bitrateMax = Math.min(Math.round(targetBitrate * 1.2), BITRATE_CEILING);

    const streamConnection = mediaConnections.find((connection) => connection.streamUserId === currentUserId);
    if (streamConnection) {
        const params = streamConnection.videoStreamParameters[0];
        params.maxFrameRate = store.fps;
        params.maxResolution = { type: "fixed", width, height };
        params.maxPixelCount = width * height;
        params.maxBitrate = bitrateMax;

        streamConnection.videoQualityManager.goliveMaxQuality.bitrateMin = bitrateMin;
        streamConnection.videoQualityManager.goliveMaxQuality.bitrateMax = bitrateMax;
        streamConnection.videoQualityManager.goliveMaxQuality.bitrateTarget = targetBitrate;

        void applySenderEncodeLimits(streamConnection, height, store.fps, bitrateMax);
        preferMacVideoToolboxH264(streamConnection);

        log(
            `Patched current user's stream with resolution: (${width}x${height}) ${store.fps}FPS @ ${(targetBitrate / 1_000_000).toFixed(1)}Mbps (min ${(bitrateMin / 1_000_000).toFixed(1)} / max ${(bitrateMax / 1_000_000).toFixed(1)}).`,
        );
        if (!loggedEncoderForCurrentStream) {
            loggedEncoderForCurrentStream = true;
            void logEncoderImplementation(streamConnection);
        }
    }
}

interface StreamDispatch {
    streamKey?: string;
    reason?: string;
}
function onStreamEnd(dispatch: StreamDispatch) {
    if (!dispatch.streamKey) return;
    const owner = dispatch.streamKey.split(":").at(-1);
    // @ts-expect-error fix types
    const currentUserId = UserStore.getCurrentUser().id;
    if (dispatch.reason === "user_requested" && owner === currentUserId) {
        window.legcord.screenshare.venmicStop();
    }
    if (owner === currentUserId) {
        loggedEncoderForCurrentStream = false;
    }
}

export function onLoad() {
    log("Legcord Screenshare Module");
    store.i18n = window.legcord.translations;
    window.legcord.screenshare.getSources(async (_event: Electron.IpcRendererEvent, sources: IPCSources[]) => {
        let audioSources: Node[] | undefined;
        if (window.legcord.platform === "linux") {
            const venmic = await window.legcord.screenshare.venmicList();
            if (venmic.ok) {
                audioSources = venmic.targets;
                console.log(`Venmic audio source targets: ${audioSources.map((node) => node["node.name"])}`);
            } else {
                console.log("Venmic is NOT OK. Venmic will not be available for screensharing with audio.");
            }
        }
        openModal(({ close }: { close: () => void }) => (
            <ScreensharePicker sources={sources} close={close} audioSources={audioSources} />
        ));
    });
    patchNavigator();
    intercept((dispatch) => {
        if (dispatch.type === "MEDIA_ENGINE_SET_GO_LIVE_SOURCE") {
            console.log("Intercepted stream quality change dispatch", dispatch);
            dispatch.settings.qualityOptions = {
                frameRate: store.fps,
                resolution: store.resolution,
                preset: 3,
            };
            return dispatch;
        }
    });
    dispatcher.subscribe("MEDIA_ENGINE_VIDEO_SOURCE_QUALITY_CHANGED", onStreamQualityChange);
    dispatcher.subscribe("STREAM_DELETE", onStreamEnd);
}

export function onUnload() {
    dispatcher.unsubscribe("MEDIA_ENGINE_VIDEO_SOURCE_QUALITY_CHANGED", onStreamQualityChange);
    dispatcher.unsubscribe("STREAM_DELETE", onStreamEnd);
}
