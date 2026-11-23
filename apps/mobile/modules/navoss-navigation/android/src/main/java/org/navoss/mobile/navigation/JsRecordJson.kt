package org.navoss.mobile.navigation

import org.json.JSONArray
import org.json.JSONObject

/**
 * A JS record (trip, fix) as the core's JSON. A key whose value is `null` is kept as JSON `null`:
 * contract v2 reads an explicit `null` as `nil` for an optional field and refuses it
 * (`invalid-json`) for a required one, as iOS's Expo records do. Leaving the key out instead would
 * be wrong, because the core defaults an absent non-optional field (a zero coordinate passes
 * validation) and would invent a position. [onNull] receives the path of each null key (names and
 * indices only, never a value).
 */
internal object JsRecordJson {
  fun encode(record: Map<String, Any?>, onNull: (path: String) -> Unit = {}): String =
    objectOf(record, "", onNull).toString()

  private fun objectOf(record: Map<*, *>, path: String, onNull: (String) -> Unit): JSONObject {
    val json = JSONObject()
    for ((key, value) in record) {
      val name = key.toString()
      val child = if (path.isEmpty()) name else "$path.$name"
      if (value == null) {
        onNull(child)
        json.put(name, JSONObject.NULL)
      } else {
        json.put(name, valueOf(value, child, onNull))
      }
    }
    return json
  }

  private fun valueOf(value: Any, path: String, onNull: (String) -> Unit): Any = when (value) {
    is Map<*, *> -> objectOf(value, path, onNull)
    is Iterable<*> -> JSONArray().also { array ->
      value.forEachIndexed { index, item ->
        array.put(item?.let { valueOf(it, "$path[$index]", onNull) } ?: JSONObject.NULL)
      }
    }
    is Array<*> -> valueOf(value.asList(), path, onNull)
    else -> value
  }
}
