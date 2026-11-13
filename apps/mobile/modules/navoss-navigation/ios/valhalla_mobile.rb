# Fetches the on-device Valhalla engine for offline routing: Rallista valhalla-mobile 0.6.4 (MIT),
# which embeds Valhalla 3.9.1, the engine the offline bundles' `routingEngineVersion` names.
#
# Only the prebuilt static XCFramework and the IANA tzdata archive it ships are used; NavOSS talks
# to the engine through its own small Objective-C++ bridge (`Valhalla/NavOSSValhallaActor.mm`), so
# none of the wrapper's Swift packages are linked. Both downloads are pinned by SHA-256 (the same
# checksum the upstream Package.swift declares for the XCFramework) and verified before use.
#
# The podspec calls `ensure!` while CocoaPods evaluates it, so `pod install` (and therefore
# `expo prebuild`, EAS builds and CI) always has the engine without committing a 22 MB binary.
# Set NAVOSS_VALHALLA_MOBILE_CACHE to a directory to reuse downloads across clean checkouts.

require 'digest'
require 'fileutils'
require 'tmpdir'

module NavOSSValhallaMobile
  VERSION = '0.6.4'
  COMMIT = '852dd75c356ecbcd0fa693dcbdd7178059013f4c'
  XCFRAMEWORK_URL =
    "https://github.com/Rallista/valhalla-mobile/releases/download/#{VERSION}/valhalla-wrapper.xcframework.zip"
  XCFRAMEWORK_SHA256 = 'c12b796de073e89f6b0be02cbfabf845a324166467609268d747c094d27ddb47'
  TZDATA_URL =
    "https://raw.githubusercontent.com/Rallista/valhalla-mobile/#{COMMIT}/apple/Sources/Valhalla/SupportData/tzdata.tar"
  TZDATA_SHA256 = '0d28b24fbbe940be9e0522086358ba74a438e4d81d2da4a2d290db929b7a8649'

  # Directory, relative to the podspec, holding `valhalla-wrapper.xcframework` and `tzdata.tar`.
  RELATIVE_DIRECTORY = "Vendor/valhalla-mobile-#{VERSION}"

  def self.ensure!(podspec_directory)
    destination = File.join(podspec_directory, RELATIVE_DIRECTORY)
    marker = File.join(destination, '.verified')
    return destination if File.exist?(marker) && File.read(marker).strip == XCFRAMEWORK_SHA256

    FileUtils.rm_rf(destination)
    Dir.mktmpdir('navoss-valhalla-mobile') do |work|
      zip = fetch(XCFRAMEWORK_URL, XCFRAMEWORK_SHA256, File.join(work, 'xcframework.zip'))
      tzdata = fetch(TZDATA_URL, TZDATA_SHA256, File.join(work, 'tzdata.tar'))
      staging = File.join(work, 'staging')
      FileUtils.mkdir_p(staging)
      run('/usr/bin/ditto', '-x', '-k', zip, staging)
      framework = File.join(staging, 'valhalla-wrapper.xcframework')
      raise 'valhalla-mobile archive has no valhalla-wrapper.xcframework' unless File.directory?(framework)

      FileUtils.cp(tzdata, File.join(staging, 'tzdata.tar'))
      File.write(File.join(staging, '.verified'), "#{XCFRAMEWORK_SHA256}\n")
      FileUtils.mkdir_p(File.dirname(destination))
      FileUtils.mv(staging, destination)
    end
    destination
  end

  def self.fetch(url, sha256, path)
    cache = ENV['NAVOSS_VALHALLA_MOBILE_CACHE']
    cached = cache && File.join(cache, sha256)
    if cached && File.exist?(cached) && Digest::SHA256.file(cached).hexdigest == sha256
      FileUtils.cp(cached, path)
      return path
    end
    run('/usr/bin/curl', '--fail', '--location', '--silent', '--show-error', '--retry', '3',
        '--output', path, url)
    actual = Digest::SHA256.file(path).hexdigest
    raise "#{url} SHA-256 #{actual} does not match the pinned #{sha256}" unless actual == sha256

    if cached
      FileUtils.mkdir_p(cache)
      FileUtils.cp(path, cached)
    end
    path
  end

  def self.run(*command)
    system(*command) || raise("#{command.first} failed (#{$?.exitstatus})")
  end
end

NavOSSValhallaMobile.ensure!(__dir__) if $PROGRAM_NAME == __FILE__
