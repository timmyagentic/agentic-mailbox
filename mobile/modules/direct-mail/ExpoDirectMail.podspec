Pod::Spec.new do |s|
  s.name = 'ExpoDirectMail'
  s.version = '1.0.0'
  s.summary = 'On-device QQ and 163 mail transport'
  s.homepage = 'https://github.com/timmyagentic/agentic-mailbox'
  s.source = { :git => s.homepage }
  s.author = 'Agentic Mailbox contributors'
  s.license = 'MIT'
  s.platform = :ios, '16.0'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = 'ios/*.swift'
  s.vendored_frameworks = 'build/Directmail.xcframework'
  s.frameworks = 'Security', 'Foundation'
end
