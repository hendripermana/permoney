class PosthogProxyController < ApplicationController
  skip_authentication
  skip_before_action :verify_authenticity_token

  def proxy
    # Construct target URL
    path = params[:path]
    path = "#{path}.#{params[:format]}" if params[:format].present?
    
    target_url = "https://us.i.posthog.com/#{path}"
    target_url += "?#{request.query_string}" if request.query_string.present?

    # Forward request using Faraday
    response = Faraday.new.send(request.method.downcase, target_url) do |req|
      req.body = request.raw_post if request.post?
      req.headers['Content-Type'] = request.content_type if request.content_type
      req.headers['User-Agent'] = request.user_agent
      req.headers['X-Forwarded-For'] = request.remote_ip
    end

    # Forward response
    render body: response.body, status: response.status, content_type: response.headers['content-type']
  end
end
