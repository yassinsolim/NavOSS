require 'json'
require_relative 'valhalla_mobile'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'NavOSSNavigation'
  s.version          = package['version']
  s.summary          = package['description']
  s.description      = package['description']
  s.license          = package['license']
  s.author           = package['author']
  s.homepage         = package['homepage']
  s.platforms        = { :ios => '16.4' }
  s.swift_version    = '5.9'
  s.source           = { :git => package['repository']['url'], :tag => s.version.to_s }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  if ENV['NAVOSS_GOOGLE_PLACES_ENABLED'] == '1'
    s.dependency 'GooglePlacesSwift', '10.15.0'
  end

  # Offline routing engine: a pinned, checksum-verified prebuilt XCFramework (see valhalla_mobile.rb).
  valhalla = NavOSSValhallaMobile::RELATIVE_DIRECTORY
  NavOSSValhallaMobile.ensure!(__dir__)
  s.vendored_frameworks = "#{valhalla}/valhalla-wrapper.xcframework"
  s.resource_bundles = { 'NavOSSValhalla' => ["#{valhalla}/tzdata.tar"] }
  s.libraries = 'c++', 'sqlite3', 'z'

  s.source_files = '*.swift', 'Core/**/*.swift', 'Offline/**/*.{swift,h,mm}'
  s.public_header_files = 'Offline/NavOSSValhallaActor.h'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => "$(inherited)#{ENV['NAVOSS_GOOGLE_PLACES_ENABLED'] == '1' ? ' NAVOSS_GOOGLE_PLACES' : ''}"
  }
end