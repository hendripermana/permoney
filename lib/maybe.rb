module Maybe
  # Semantic version for display/links in UI
  def self.version
    @version ||= Semver.new(ENV["APP_VERSION"].to_s.strip.empty? ? "0.0.0" : ENV["APP_VERSION"])
  end

  # Commit SHA injected at build time (compose passes BUILD_COMMIT_SHA)
  def self.commit_sha
    sha = ENV["BUILD_COMMIT_SHA"].to_s.strip
    sha.empty? ? nil : sha
  end
end
