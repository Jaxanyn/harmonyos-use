#include <atomic>
#include <cstdint>
#include <mutex>
#include <node_api.h>
#include <multimedia/player_framework/native_avscreen_capture.h>

namespace {
std::mutex captureMutex;
OH_AVScreenCapture *capture = nullptr;
std::atomic<int64_t> frames{0};
std::atomic<int64_t> firstTimestamp{0};
std::atomic<int64_t> lastTimestamp{0};
std::atomic<int32_t> captureState{-1};
std::atomic<int32_t> captureError{0};
std::atomic<int32_t> releaseError{0};

void OnFrame(OH_AVScreenCapture *, OH_AVBuffer *, OH_AVScreenCaptureBufferType type, int64_t timestamp, void *) {
    if (type != OH_SCREEN_CAPTURE_BUFFERTYPE_VIDEO) return;
    int64_t expected = 0;
    firstTimestamp.compare_exchange_strong(expected, timestamp);
    lastTimestamp.store(timestamp);
    frames.fetch_add(1);
}

void OnState(OH_AVScreenCapture *, OH_AVScreenCaptureStateCode state, void *) {
    captureState.store(static_cast<int32_t>(state));
}

void OnError(OH_AVScreenCapture *, int32_t error, void *) {
    captureError.store(error);
}

napi_value Number(napi_env env, int32_t number) {
    napi_value value = nullptr;
    if (napi_create_int32(env, number, &value) != napi_ok) return nullptr;
    return value;
}

int32_t StopCapture() {
    std::lock_guard<std::mutex> lock(captureMutex);
    if (!capture) return 0;
    OH_AVScreenCapture *current = capture;
    int32_t stopResult = static_cast<int32_t>(OH_AVScreenCapture_StopScreenCapture(current));
    int32_t releaseResult = static_cast<int32_t>(OH_AVScreenCapture_Release(current));
    releaseError.store(releaseResult);
    if (releaseResult == 0) capture = nullptr;
    return releaseResult != 0 ? releaseResult : stopResult;
}

napi_value Start(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2] = {nullptr, nullptr};
    int32_t width = 0;
    int32_t height = 0;
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 2 ||
        napi_get_value_int32(env, args[0], &width) != napi_ok || napi_get_value_int32(env, args[1], &height) != napi_ok ||
        width < 2 || width > 4096 || height < 2 || height > 4096) return Number(env, -1);
    std::lock_guard<std::mutex> lock(captureMutex);
    if (capture) return Number(env, -2);
    OH_AVScreenCapture *next = OH_AVScreenCapture_Create();
    if (!next) return Number(env, -3);
    frames.store(0);
    firstTimestamp.store(0);
    lastTimestamp.store(0);
    captureState.store(-1);
    captureError.store(0);
    OH_AVScreenCaptureConfig config{};
    config.captureMode = OH_CAPTURE_HOME_SCREEN;
    config.dataType = OH_ORIGINAL_STREAM;
    config.videoInfo.videoCapInfo.videoFrameWidth = width;
    config.videoInfo.videoCapInfo.videoFrameHeight = height;
    config.videoInfo.videoCapInfo.videoSource = OH_VIDEO_SOURCE_SURFACE_RGBA;
    int32_t result = static_cast<int32_t>(OH_AVScreenCapture_SetStateCallback(next, OnState, nullptr));
    if (result == 0) result = static_cast<int32_t>(OH_AVScreenCapture_SetErrorCallback(next, OnError, nullptr));
    if (result == 0) result = static_cast<int32_t>(OH_AVScreenCapture_SetDataCallback(next, OnFrame, nullptr));
    if (result == 0) result = static_cast<int32_t>(OH_AVScreenCapture_Init(next, config));
    if (result == 0) result = static_cast<int32_t>(OH_AVScreenCapture_SetMicrophoneEnabled(next, false));
    if (result == 0) result = static_cast<int32_t>(OH_AVScreenCapture_StartScreenCapture(next));
    if (result != 0) {
        int32_t releaseResult = static_cast<int32_t>(OH_AVScreenCapture_Release(next));
        releaseError.store(releaseResult);
        if (releaseResult != 0) {
            capture = next;
            captureError.store(releaseResult);
            return Number(env, releaseResult);
        }
        return Number(env, result);
    }
    capture = next;
    return Number(env, 0);
}

napi_value Stop(napi_env env, napi_callback_info) { return Number(env, StopCapture()); }

napi_value Stats(napi_env env, napi_callback_info) {
    napi_value result = nullptr;
    if (napi_create_object(env, &result) != napi_ok) return nullptr;
    int32_t active = 0;
    {
        std::lock_guard<std::mutex> lock(captureMutex);
        active = capture ? 1 : 0;
    }
    int64_t first = firstTimestamp.load();
    int64_t last = lastTimestamp.load();
    int64_t elapsed = first > 0 && last >= first ? (last - first) / 1000000 : 0;
    napi_value frameCount = nullptr;
    napi_value elapsedMs = nullptr;
    napi_value activeValue = Number(env, active);
    napi_value state = Number(env, captureState.load());
    napi_value error = Number(env, captureError.load());
    napi_value release = Number(env, releaseError.load());
    if (napi_create_int64(env, frames.load(), &frameCount) != napi_ok ||
        napi_create_int64(env, elapsed, &elapsedMs) != napi_ok || !activeValue || !state || !error || !release ||
        napi_set_named_property(env, result, "active", activeValue) != napi_ok ||
        napi_set_named_property(env, result, "frames", frameCount) != napi_ok ||
        napi_set_named_property(env, result, "elapsedMs", elapsedMs) != napi_ok ||
        napi_set_named_property(env, result, "state", state) != napi_ok ||
        napi_set_named_property(env, result, "error", error) != napi_ok ||
        napi_set_named_property(env, result, "releaseError", release) != napi_ok) return nullptr;
    return result;
}

void Cleanup(void *) { StopCapture(); }

napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor descriptors[] = {
        {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stats", nullptr, Stats, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    if (napi_add_env_cleanup_hook(env, Cleanup, nullptr) != napi_ok ||
        napi_define_properties(env, exports, sizeof(descriptors) / sizeof(descriptors[0]), descriptors) != napi_ok) return nullptr;
    return exports;
}

napi_module module = { 1, 0, nullptr, Init, "captureprobe", nullptr, {0} };
}

extern "C" __attribute__((constructor)) void RegisterCaptureProbe() { napi_module_register(&module); }
