#pragma once
// The NDK's JNI header, for the Swift JNI entry points, and its log. Android only.
#if defined(__ANDROID__)
#include <android/log.h>
#include <jni.h>

// An error line in logcat under the tag NavOSSCore. Callers pass fixed text and names, never
// anything from a trip, a fix, a request or an exception.
static inline void navoss_log_error(const char *text) {
  __android_log_write(ANDROID_LOG_ERROR, "NavOSSCore", text);
}
#endif
