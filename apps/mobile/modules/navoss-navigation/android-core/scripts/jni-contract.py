#!/usr/bin/env python3
"""The JNI boundary between the Kotlin binding and the Swift core, read from their sources.

  jni-contract.py check              the Kotlin `external` functions and the Swift `@_cdecl`
                                     entry points agree, and every Host method the Swift side looks
                                     up exists in the Kotlin Host interface with that signature
  jni-contract.py symbols            the JNI symbol of each Kotlin `external` function, one a line
  jni-contract.py dex-members FILE   check that `apkanalyzer dex packages --defined-only` output
                                     (FILE) still has every class and member JNI reaches by name,
                                     unrenamed: R8 must neither strip nor rename them

Nothing here is a hand-kept list. The names come from the Kotlin `external` functions and from
every lookup the Swift JNI layer makes (`FindClass`, `GetMethodID`, ...); a lookup of a kind this
script cannot attribute fails `check`, so a new one needs this script and a keep rule in
modules/navoss-navigation/android/consumer-rules.pro before CI passes.
"""

import pathlib
import re
import sys

CORE = pathlib.Path(__file__).resolve().parent.parent
KOTLIN = CORE / "binding" / "src" / "main" / "kotlin"
SWIFT = CORE / "JNI" / "NavOSSCoreJNI"

JNI_TYPES = {
    "Int": "I",
    "Long": "J",
    "Boolean": "Z",
    "Double": "D",
    "Float": "F",
    "Short": "S",
    "Byte": "B",
    "Char": "C",
    "String": "Ljava/lang/String;",
    "Unit": "V",
}
JAVA_TYPES = {"I": "int", "J": "long", "Z": "boolean", "D": "double", "F": "float", "S": "short",
              "B": "byte", "C": "char", "V": "void"}


def fail(message):
    print(f"jni-contract: {message}", file=sys.stderr)
    sys.exit(1)


def jni_escape(name):
    """JNI short-name mangling for one identifier (no Unicode in these names)."""
    return name.replace("_", "_1").replace("$", "_00024")


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


def descriptor(params, result, nested=None):
    """JNI descriptor of a Kotlin signature; `nested` maps types declared inside the binding
    class (such as Host) to their JNI class names."""
    def one(kotlin_type):
        kotlin_type = kotlin_type.strip().rstrip("?")
        if nested and kotlin_type in nested:
            return f"L{nested[kotlin_type]};"
        if kotlin_type not in JNI_TYPES:
            fail(f"no JNI mapping for Kotlin type {kotlin_type}")
        return JNI_TYPES[kotlin_type]

    types = [p.split(":", 1)[1] for p in params.split(",") if p.strip()]
    return "(" + "".join(one(t) for t in types) + ")" + one(result or "Unit")


def kotlin_externals():
    """(jni symbol, class, method, descriptor) for every `external fun` in the binding."""
    found = []
    for path in sorted(KOTLIN.rglob("*.kt")):
        text = strip_comments(path.read_text())
        externals = list(re.finditer(
            r"((?:@\w+\s+)*)(?:(?:private|internal|public)\s+)?external\s+fun\s+(\w+)\s*"
            r"\(([^)]*)\)\s*(?::\s*([\w?]+))?", text))
        if not externals:
            continue
        package = re.search(r"^package\s+([\w.]+)", text, re.M)
        classes = re.findall(r"^class\s+(\w+)", text, re.M)
        if not package or len(classes) != 1:
            fail(f"{path}: externals need a package and exactly one top-level class")
        owner = f"{package.group(1)}.{classes[0]}"
        nested = {name: f"{owner.replace('.', '/')}${name}" for name in re.findall(
            r"^\s+(?:\w+\s+)*(?:interface|class)\s+(\w+)", text, re.M)}
        for match in externals:
            annotations, name, params, result = match.groups()
            # A companion member without @JvmStatic binds to `Outer$Companion`, which this
            # check (and the Swift side) does not expect.
            if "@JvmStatic" not in annotations:
                fail(f"{path}: external fun {name} is not @JvmStatic")
            symbol = "Java_" + "_".join(
                [jni_escape(part) for part in package.group(1).split(".")]
                + [jni_escape(classes[0]), jni_escape(name)])
            found.append((symbol, owner, name, descriptor(params, result, nested)))
    if not found:
        fail(f"no external functions under {KOTLIN}")
    return found


def swift_text():
    return strip_comments("\n".join(p.read_text() for p in sorted(SWIFT.rglob("*.swift"))))


def swift_cdecls():
    return re.findall(r'@_cdecl\("(Java_\w+)"\)', swift_text())


def swift_host_lookups():
    """(name, JNI signature) of every method the Swift side looks up on the Host object."""
    return re.findall(r'\bmethod\("(\w+)",\s*"([^"]+)"\)', swift_text())


# JNI calls that find a class, method or field by name. Each one the Swift side makes must be
# one of the patterns `swift_lookups` understands, so a new kind of lookup fails here (and needs a
# keep rule) instead of failing on a phone.
LOOKUP_CALLS = ("FindClass", "GetObjectClass", "GetMethodID", "GetStaticMethodID", "GetFieldID",
                "GetStaticFieldID", "RegisterNatives", "ThrowNew", "NewObject", "NewObjectA",
                "NewObjectV", "AllocObject")


def swift_lookups(binding):
    """class -> set of `(name, JNI descriptor)` the Swift JNI layer finds by name; an empty set
    for a class found only for itself. Fails on any lookup it cannot attribute."""
    text = swift_text()
    constants = dict(re.findall(r'\blet\s+(\w+)\s*=\s*"([\w/$]+)"', text))
    host = f"{binding}$Host"
    found = {}
    # Function and initializer bodies: from one declaration to the next is precise enough for
    # this file's layout.
    parts = re.split(r"\b(?:func\s+(\w+)|(init)\??)\s*[(<]", text)
    for index in range(1, len(parts), 3):
        name, body = parts[index] or parts[index + 1], parts[index + 2]
        calls = re.findall(r'\bjni\.(\w+)\(\s*env\s*,\s*((?:"[^"]*"|[^)"])*)\)', body)
        calls = [(call, args) for call, args in calls if call in LOOKUP_CALLS]
        if not calls:
            continue
        classes = []
        for call, args in calls:
            first = args.split(",")[0].strip()
            if call == "FindClass":
                value = constants.get(first) or (first.strip('"') if first.startswith('"') else None)
                if value is None:
                    fail(f"func {name}: FindClass with a computed name ({first})")
                classes.append(value.replace("/", "."))
                found.setdefault(classes[-1], set())
        for call, args in calls:
            literals = re.findall(r'"([^"]*)"', args)
            if call in ("FindClass", "NewObjectA", "NewObject", "NewObjectV"):
                continue
            if call == "GetObjectClass" and name == "init":
                continue  # the Host object: its methods are looked up through `method(...)`
            if call == "GetMethodID" and len(literals) == 2 and len(classes) == 1:
                found[classes[0]].add(tuple(literals))
            elif call == "GetMethodID" and name == "method" and not literals:
                continue  # the Host helper; its call sites are read below
            else:
                fail(f"func {name}: jni.{call}({args.strip()}) is a lookup this check does not "
                     "understand; extend jni-contract.py and the module's consumer-rules.pro")
    found.setdefault(host, set()).update(swift_host_lookups())
    return found


def kotlin_host_methods(binding_class):
    """name -> descriptor for the Host interface nested in the binding class."""
    path = KOTLIN.joinpath(*binding_class.split(".")[:-1], binding_class.split(".")[-1] + ".kt")
    text = strip_comments(path.read_text())
    body = re.search(r"\binterface\s+Host\s*\{(.*?)\n\s*\}", text, re.S)
    if not body:
        fail(f"{path}: no Host interface")
    return {name: descriptor(params, result) for name, params, result in re.findall(
        r"\bfun\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*([\w?]+))?", body.group(1))}


def java_signature(name, jni_descriptor):
    """`apkanalyzer` form: `<return> <name>(<param>,...)`."""
    def types(spec):
        out, i = [], 0
        while i < len(spec):
            if spec[i] == "L":
                end = spec.index(";", i)
                out.append(spec[i + 1:end].replace("/", "."))
                i = end + 1
            else:
                out.append(JAVA_TYPES[spec[i]])
                i += 1
        return out
    params, result = re.fullmatch(r"\((.*)\)(.+)", jni_descriptor).groups()
    if name == "<init>":
        return f"<init>({','.join(types(params))})"
    return f"{types(result)[0]} {name}({','.join(types(params))})"


def check():
    externals = kotlin_externals()
    kotlin = {e[0] for e in externals}
    swift = swift_cdecls()
    if len(swift) != len(set(swift)):
        fail("a Swift @_cdecl name appears twice")
    status = 0
    for symbol in sorted(kotlin - set(swift)):
        print(f"::error::Kotlin declares {symbol}, the Swift core does not export it")
        status = 1
    for symbol in sorted(set(swift) - kotlin):
        print(f"::error::the Swift core exports {symbol}, no Kotlin external declares it")
        status = 1
    host = kotlin_host_methods(externals[0][1])
    for name, signature in swift_host_lookups():
        if host.get(name) != signature:
            print(f"::error::Swift looks up Host.{name}{signature}; Kotlin declares "
                  f"{host.get(name, 'nothing')}")
            status = 1
    binding = externals[0][1]
    for owner, members in swift_lookups(binding).items():
        if owner == f"{binding}$Host":
            continue
        path = KOTLIN.joinpath(*owner.split(".")[:-1], owner.split(".")[-1] + ".kt")
        if not path.exists():
            continue  # a platform class
        text = strip_comments(path.read_text())
        simple = owner.split(".")[-1]
        primary = re.search(rf"\bclass\s+{re.escape(simple)}\s*\(([^)]*)\)", text)
        for name, signature in members:
            params = re.sub(r"\b(?:val|var|private|internal)\s+", "", primary.group(1)) if primary else None
            if name != "<init>" or params is None or descriptor(params, "Unit") != signature:
                print(f"::error::Swift looks up {owner}.{name}{signature}; the Kotlin source does "
                      "not declare it as a primary constructor this check can read")
                status = 1
    if status:
        sys.exit(status)
    print(f"JNI contract: {len(kotlin)} entry points and {len(swift_host_lookups())} Host "
          f"callbacks agree between Kotlin and Swift")


def dex_members(listing):
    lines = pathlib.Path(listing).read_text().splitlines()
    # `<kind> <state> <counts>\t...\t<class>[ <member>]`: the last tab field names the item.
    classes = {l.split("\t")[-1] for l in lines if l.startswith("C ")}
    methods = {l.split("\t")[-1] for l in lines if l.startswith("M ")}
    externals = kotlin_externals()
    binding = externals[0][1]
    expected = {binding: {java_signature(e[2], e[3]) for e in externals}}
    for owner, members in swift_lookups(binding).items():
        expected.setdefault(owner, set()).update(java_signature(n, d) for n, d in members)
    missing = []
    for owner, members in expected.items():
        if owner not in classes:
            missing.append(f"class {owner}")
            continue
        missing += [f"{owner} {m}" for m in sorted(members) if f"{owner} {m}" not in methods]
    if missing:
        for item in missing:
            print(f"::error::not in the APK's dex under its JNI name: {item}")
        fail("R8 stripped or renamed something JNI needs (keep rules: docs/architecture/android-core.md)")
    print(f"dex keeps {sum(len(m) for m in expected.values())} JNI members of "
          f"{len(expected)} classes by name")


def main():
    if sys.argv[1:] == ["check"]:
        check()
    elif sys.argv[1:] == ["symbols"]:
        print("\n".join(e[0] for e in kotlin_externals()))
    elif len(sys.argv) == 3 and sys.argv[1] == "dex-members":
        dex_members(sys.argv[2])
    else:
        fail(__doc__)


if __name__ == "__main__":
    main()
