module StreamExtensions
  extend ActiveSupport::Concern

  # Render a Turbo Stream redirect immediately
  def stream_redirect_to(path, notice: nil, alert: nil)
    render turbo_stream: redirect_stream_action(path, notice: notice, alert: alert)
  end

  def stream_redirect_back_or_to(path, notice: nil, alert: nil)
    render turbo_stream: redirect_stream_action(path, redirect_back: true, notice: notice, alert: alert)
  end

  # Build a Turbo Stream redirect action for composing custom responses
  def build_stream_redirect_to(path, notice: nil, alert: nil)
    redirect_stream_action(path, notice: notice, alert: alert)
  end

  def build_stream_redirect_back_or_to(path, notice: nil, alert: nil)
    redirect_stream_action(path, redirect_back: true, notice: notice, alert: alert)
  end

  private
    def redirect_stream_action(path, redirect_back: false, notice: nil, alert: nil)
      flash[:notice] = notice if notice.present?
      flash[:alert] = alert if alert.present?

      redirect_target_url = redirect_back ? (request.referer.presence || path) : path
      turbo_stream.action(:redirect, redirect_target_url)
    end
end
