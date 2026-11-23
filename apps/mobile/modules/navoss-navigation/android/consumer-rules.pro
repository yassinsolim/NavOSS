# The Swift core (android-core/JNI/NavOSSCoreJNI.swift) finds these by name through JNI.
-keep interface org.navoss.navigation.core.NavOSSCore$Host { *; }
-keep class org.navoss.navigation.core.NavOSSCoreException { <init>(java.lang.String, java.lang.String); }
-keepclasseswithmembernames,includedescriptorclasses class org.navoss.navigation.core.NavOSSCore { native <methods>; }
