package org.navoss.mobile.navigation

import org.json.JSONArray
import org.json.JSONObject

/**
 * A JS record (trip, fix) as the core's JSON. A key whose value is `null` is left out: contract v2
 * reads an absent optional field as `nil` but refuses an explicit `null` for a required one, and
 * an absent required field is refused the same way (`invalid-json`), so dropping changes no
 * outcome except that an optional `null` is accepted, as on iOS (Expo maps it to `nil`).
 * [onDroppedNull] receives the path of each dropped key (names and indices only, never a value).
 */
internal object JsRecordJson {
  fun encode(record: Map<String, Any?>, onDroppedNull: (path: String) -> Unit = {}): String =
    objectOf(record, "", onDroppedNull).toString()

  private fun objectOf(record: Map<*, *>, path: String, onDroppedNull: (String) -> Unit): JSONObject {
    val json = JSONObject()
    for ((key, value) in record) {
      val name = key.toString()
      val child = if (path.isEmpty()) name else "$path.$name"
      if (value == null) onDroppedNull(child) else json.put(name, valueOf(value, child, onDroppedNull))
    }
    return json
  }

  private fun valueOf(value: Any, path: String, onDroppedNull: (String) -> Unit): Any = when (value) {
    is Map<*, *> -> objectOf(value, path, onDroppedNull)
    is Iterable<*> -> JSONArray().also { array ->
      value.forEachIndexed { index, item ->
        array.put(item?.let { valueOf(it, "$path[$index]", onDroppedNull) } ?: JSONObject.NULL)
      }
    }
    is Array<*> -> valueOf(value.asList(), path, onDroppedNull)
    else -> value
  }
}
