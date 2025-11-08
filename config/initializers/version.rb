module Permoney
  class << self
    def version
      Semver.new(semver)
    end

    def latest_version_available?
      VersionChecker.update_available?
    end

    def latest_release_url
      VersionChecker.release_url
    end

    def commit_sha
      if Rails.env.production?
        ENV["BUILD_COMMIT_SHA"]
      else
        `git rev-parse HEAD`.chomp
      end
    end

    private
      def semver
        "0.96"  # Current version (fallback for offline/disconnected environments)
      end
  end
end
