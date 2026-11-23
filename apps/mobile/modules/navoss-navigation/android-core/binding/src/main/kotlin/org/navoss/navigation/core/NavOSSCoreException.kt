package org.navoss.navigation.core

/** A failure reported by the core. [code] is stable; see "Errors" in the contract. */
class NavOSSCoreException(val code: String, message: String) : RuntimeException("$code: $message")
