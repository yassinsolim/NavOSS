#!/usr/bin/env bash
# Negative tests for the checkers: each broken input below must make its checker fail (with the
# expected message), and the unbroken input must pass. A checker that passes a broken input
# protects nothing.
#
#   test-verify-scripts.sh contract            jni-contract.py against mutated copies of the
#                                              Kotlin binding and the Swift JNI layer
#   test-verify-scripts.sh libraries <jniLibs> verify-android-core.sh against broken copies of
#                                              verified libraries (needs NDK r30, as that script)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
core="$(cd "$here/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
failures=0
cases=0

# expect <name> <pass|fail> <message substring> <command...>
expect() {
  local name="$1" outcome="$2" message="$3" output status=0
  shift 3
  cases=$((cases + 1))
  output="$("$@" 2>&1)" || status=$?
  if [[ "$outcome" == pass && $status -ne 0 ]]; then
    echo "::error::$name: expected to pass, failed: $(tail -3 <<<"$output")"
    failures=$((failures + 1))
  elif [[ "$outcome" == fail && $status -eq 0 ]]; then
    echo "::error::$name: a broken input passed the check"
    failures=$((failures + 1))
  elif [[ "$outcome" == fail ]] && ! grep -qF -- "$message" <<<"$output"; then
    echo "::error::$name: failed without '$message': $(tail -3 <<<"$output")"
    failures=$((failures + 1))
  else
    echo "ok   $name ($outcome)"
  fi
}

# A copy of the contract's inputs in the layout jni-contract.py expects, with one edit applied.
contract_copy() {
  local name="$1" file="$2" python="$3" copy="$scratch/$1/android-core"
  mkdir -p "$copy/scripts" "$copy/binding/src/main"
  cp "$here/jni-contract.py" "$copy/scripts/"
  cp -R "$core/JNI" "$copy/"
  cp -R "$core/binding/src/main/kotlin" "$copy/binding/src/main/"
  if [[ -n "$file" ]]; then
    python3 - "$copy/$file" "$python" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
namespace = {"text": text}
exec(sys.argv[2], namespace)
if namespace["text"] == text:
    sys.exit(f"edit did not apply to {path}")
path.write_text(namespace["text"])
PY
  fi
  echo "$copy/scripts/jni-contract.py"
}

contract_tests() {
  local swift=JNI/NavOSSCoreJNI/NavOSSCoreJNI.swift
  local kotlin=binding/src/main/kotlin/org/navoss/navigation/core/NavOSSCore.kt
  expect "contract: unchanged" pass "" python3 "$(contract_copy unchanged '' '')" check
  expect "contract: computed descriptor" fail "NavOSSCoreJNI.swift:" python3 "$(contract_copy computed-descriptor "$swift" \
    'text = text.replace("\"nowMs\", \"()D\")", "\"nowMs\", nowMsSignature)")')" check
  expect "contract: computed class name" fail "NavOSSCoreJNI.swift:" python3 "$(contract_copy computed-class "$swift" \
    'text = text.replace("FindClass(env, \"org/navoss/navigation/core/NavOSSCoreException\")", "FindClass(env, exceptionClassName)")')" check
  expect "contract: lookup through a helper" fail "NavOSSCoreJNI.swift:" python3 "$(contract_copy helper "$swift" \
    'text = text.replace("      // Literal names", "      func method(_ n: String, _ s: String) -> jmethodID? { jni.GetMethodID(env, type, n, s) }\n      // Literal names")')" check
  expect "contract: lookup through an alias" fail "referenced other than as a direct" python3 "$(contract_copy alias "$swift" \
    'text = text.replace("      // Literal names", "      let lookup = jni.GetMethodID\n      _ = lookup?(env, type, \"nowMs\", \"()J\")\n      // Literal names")')" check
  expect "contract: lookup through another receiver" fail "referenced other than as a direct" python3 "$(contract_copy receiver "$swift" \
    'text = text.replace("      // Literal names", "      let table = jni\n      _ = table.GetMethodID(env, type, \"nowMs\", \"()J\")\n      // Literal names")')" check
  expect "contract: static field lookup" fail "GetStaticFieldID" python3 "$(contract_copy static-field "$swift" \
    'text = text.replace("defer { jni.DeleteLocalRef(env, type) }", "defer { jni.DeleteLocalRef(env, type) }\n    _ = jni.GetStaticFieldID(env, type, \"x\", \"I\")", 1)')" check
  expect "contract: wrong Host descriptor" fail "Host.nowMs" python3 "$(contract_copy wrong-descriptor "$swift" \
    'text = text.replace("\"nowMs\", \"()D\")", "\"nowMs\", \"()J\")")')" check
  expect "contract: wrong exception constructor" fail "NavOSSCoreException.<init>" python3 "$(contract_copy wrong-init "$swift" \
    'text = text.replace("\"<init>\", \"(Ljava/lang/String;Ljava/lang/String;)V\"", "\"<init>\", \"(Ljava/lang/String;)V\"")')" check
  expect "contract: renamed entry point" fail "nativeClockTick" python3 "$(contract_copy renamed "$swift" \
    'text = text.replace("NavOSSCore_nativeClockTick", "NavOSSCore_nativeClockTock")')" check
  expect "contract: Kotlin external without Swift" fail "nativeExtra" python3 "$(contract_copy extra-external "$kotlin" \
    'text = text.replace("@JvmStatic private external fun nativeClockTick(handle: Long)", "@JvmStatic private external fun nativeClockTick(handle: Long)\n\n    @JvmStatic private external fun nativeExtra(handle: Long)")')" check
}

# A copy of verified libraries with one breakage applied by a Python snippet (`lib` is the
# arm64-v8a directory as a pathlib.Path).
libraries_copy() {
  local name="$1" python="$2" copy="$scratch/$1"
  mkdir -p "$copy"
  cp -R "$source_root/." "$copy/"
  python3 - "$copy/arm64-v8a" "$python" <<'PY'
import pathlib, struct, sys
lib = pathlib.Path(sys.argv[1])

def program_headers(path, edit):
    """Calls edit(data, offset_of_header, p_type) for every ELF64 program header."""
    data = bytearray(path.read_bytes())
    phoff, = struct.unpack_from("<Q", data, 0x20)
    phentsize, phnum = struct.unpack_from("<HH", data, 0x36)
    for index in range(phnum):
        offset = phoff + index * phentsize
        edit(data, offset, struct.unpack_from("<I", data, offset)[0])
    path.write_bytes(bytes(data))

def replace(path, old, new):
    data = path.read_bytes()
    assert old in data and len(old) == len(new)
    path.write_bytes(data.replace(old, new))

exec(sys.argv[2])
PY
  echo "$copy"
}

library_tests() {
  local verify="$here/verify-android-core.sh"
  source_root="$1"
  expect "libraries: unchanged" pass "" "$verify" "$(libraries_copy unchanged 'pass')"
  expect "libraries: non-ELF file named .so" fail "llvm-readelf failed" "$verify" "$(libraries_copy not-elf \
    '(lib / "libswiftObservation.so").write_text("not an ELF file\n")')"
  expect "libraries: ELF without LOAD segments" fail "has no LOAD segment" "$verify" "$(libraries_copy no-load \
    'program_headers(lib / "libswiftObservation.so", lambda d, o, t: struct.pack_into("<I", d, o, 0) if t == 1 else None)')"
  expect "libraries: 4 KB-aligned LOAD segment" fail "below 16 KB" "$verify" "$(libraries_copy aligned-4k \
    'program_headers(lib / "libswiftObservation.so", lambda d, o, t: struct.pack_into("<Q", d, o + 48, 0x1000) if t == 1 else None)')"
  expect "libraries: missing dependency" fail "neither shipped nor part of Android" "$verify" "$(libraries_copy missing \
    '(lib / "libswiftObservation.so").unlink()')"
  expect "libraries: unneeded library" fail "nothing in the core needs it" "$verify" "$(libraries_copy unneeded \
    '(lib / "libextra.so").write_bytes((lib / "libswiftObservation.so").read_bytes())')"
  expect "libraries: second ABI" fail "expected only arm64-v8a" "$verify" "$(libraries_copy second-abi \
    '(lib.parent / "x86_64").mkdir()')"
  expect "libraries: JNI entry point not exported" fail "does not export" "$verify" "$(libraries_copy no-export \
    'replace(lib / "libNavOSSCore.so", b"NavOSSCore_nativeClose\0", b"NavOSSCore_nativeClosX\0")')"
  expect "libraries: libc++ without the r30 symbol" fail "not NDK r30's" "$verify" "$(libraries_copy libcxx-r27 \
    'replace(lib / "libc++_shared.so", b"_ZNSt6__ndk113__hash_memoryEPKvm\0", b"_ZNSt6__ndk113__hash_memorXEPKvm\0")')"
}

case "${1:-}" in
  contract) contract_tests ;;
  libraries) library_tests "${2:?jniLibs directory}" ;;
  *) echo "usage: $0 contract | libraries <jniLibs>" >&2; exit 2 ;;
esac
((failures == 0)) || { echo "test-verify-scripts: $failures of $cases cases wrong" >&2; exit 1; }
echo "test-verify-scripts: $cases cases as expected"
