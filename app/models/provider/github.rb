class Provider::Github
  attr_reader :name, :owner, :branch

  def initialize
    # Allow runtime configuration via ENV or Setting
    @name = ENV["GITHUB_REPO_NAME"].presence || (defined?(Setting) && Setting.respond_to?(:github_repo_name) ? Setting.github_repo_name : nil) || "sure"
    @owner = ENV["GITHUB_REPO_OWNER"].presence || (defined?(Setting) && Setting.respond_to?(:github_repo_owner) ? Setting.github_repo_owner : nil) || "we-promise"
    @branch = ENV["GITHUB_REPO_BRANCH"].presence || "main"
  end

  def fetch_latest_release_notes
    begin
      Rails.cache.fetch("latest_github_release_notes", expires_in: 2.hours) do
        release = Octokit.releases(repo).first
        if release
          {
            avatar: release.author.avatar_url,
            # this is the username, it would be nice to get the full name
            username: release.author.login,
            name: release.name,
            published_at: release.published_at,
            body: Octokit.markdown(release.body, mode: "gfm", context: repo)
          }
        else
          nil
        end
      end
    rescue => e
      Rails.logger.error "Failed to fetch latest GitHub release notes: #{e.message}"
      nil
    end
  end

  # Convenience URL helpers for use in views/controllers
  def repository_url
    "https://github.com/#{owner}/#{name}"
  end

  def releases_url
    "#{repository_url}/releases"
  end

  def release_tag_url(tag)
    "#{releases_url}/tag/#{tag}"
  end

  def commit_url(sha)
    "#{repository_url}/commit/#{sha}"
  end

  def owner_avatar_url
    "https://github.com/#{owner}.png"
  end

  private
    def repo
      "#{owner}/#{name}"
    end
end
