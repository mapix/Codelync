# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# react-native-reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# Add any project specific keep options here:
# Codelync native JSI / TurboModule / WebRTC defensive keep rules
-keep class com.libsodium.** { *; }
-keep class com.mrousavy.mmkv.** { *; }
-keep class com.margelo.nitro.** { *; }
-keep class com.unistyles.** { *; }
-keep class com.reactnativequickbase64.** { *; }
-keep class com.reactnativekeyboardcontroller.** { *; }
-keep class com.livekit.** { *; }
-keep class org.webrtc.** { *; }
