cmake_minimum_required(VERSION 3.5.0)
project(captureprobe)
add_library(captureprobe SHARED capture_probe.cpp)
target_link_libraries(captureprobe PRIVATE libace_napi.z.so libnative_avscreen_capture.so)
