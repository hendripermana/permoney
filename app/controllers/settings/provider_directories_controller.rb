require "cgi"

class Settings::ProviderDirectoriesController < ApplicationController
  before_action :set_provider, only: %i[edit update destroy restore]

  layout :resolve_layout

  def index
    respond_to do |format|
      format.html do
        @breadcrumbs = [
          { text: "Home", href: root_path, icon: "home" },
          { text: "Providers", icon: "building-2" }
        ]

        @active_providers = Current.user.provider_directories.active.alphabetically
        @archived_providers = Current.user.provider_directories.archived.alphabetically
      end

      format.turbo_stream do
        per_page = 50
        page = (params[:page] || 1).to_i

        base_query = Current.user.provider_directories.active.search(params[:q]).alphabetically
        total_count = base_query.count
        @providers = base_query.offset((page - 1) * per_page).limit(per_page)
        @next_page = (page * per_page < total_count) ? page + 1 : nil
      end
    end
  end

  def new
    @provider = Current.user.provider_directories.new
  end

  def create
    @provider = Current.user.provider_directories.new(provider_params)

    if @provider.save
      respond_to do |format|
        format.html { redirect_to return_path, notice: "Provider created successfully!" }
        format.turbo_stream { respond_with_stream_redirect("Provider created successfully!") }
      end
    else
      render :new, status: :unprocessable_entity
    end
  end

  def edit
  end

  def update
    if @provider.update(provider_params)
      respond_to do |format|
        format.html { redirect_to return_path, notice: "Provider updated successfully!" }
        format.turbo_stream { respond_with_stream_redirect("Provider updated successfully!") }
      end
    else
      render :edit, status: :unprocessable_entity
    end
  end

  def destroy
    @provider.archive!

    respond_to do |format|
      format.html { redirect_to settings_provider_directories_path, notice: "Provider archived." }
      format.turbo_stream { render turbo_stream: turbo_stream.action(:redirect, settings_provider_directories_path) }
    end
  end

  def restore
    @provider.restore!

    respond_to do |format|
      format.html { redirect_to settings_provider_directories_path, notice: "Provider restored." }
      format.turbo_stream { render turbo_stream: turbo_stream.action(:redirect, settings_provider_directories_path) }
    end
  end

  private
    def set_provider
      @provider = Current.user.provider_directories.find(params[:id])
    end

    def provider_params
      params.require(:provider_directory).permit(:name, :kind, :country, :website, :notes)
    end

    def return_path
      safe_return_path(params[:return_to]) || settings_provider_directories_path
    end

    def resolve_layout
      turbo_frame_request? ? false : "settings"
    end

    def respond_with_stream_redirect(message)
      flash[:notice] = message
      render turbo_stream: turbo_stream.action(:redirect, return_path)
    end

    # Only allow internal, recognized paths to be used for redirects.
    def safe_return_path(candidate)
      return nil if candidate.blank?
      return nil unless candidate.is_a?(String)
      return nil unless candidate.start_with?("/")
      return nil if candidate.start_with?("//")
      return nil if candidate.match?(/[[:cntrl:]]/)
      return nil if candidate.match?(/%0d|%0a/i)

      decoded = begin
        CGI.unescape(candidate)
      rescue StandardError
        candidate
      end

      return nil if decoded.start_with?("//")
      return nil if decoded.match?(/\A[a-z][a-z0-9+.-]*:/i)
      return nil if decoded.start_with?("/..") || decoded.end_with?("/..")
      return nil if decoded.include?("/../") || decoded.include?("/./")

      begin
        if defined?(request) && request
          env = request.env.merge("REQUEST_METHOD" => "GET")
          Rails.application.routes.recognize_path(candidate, env)
        else
          Rails.application.routes.recognize_path(candidate, method: :get)
        end
        candidate
      rescue ActionController::RoutingError, ArgumentError
        nil
      end
    end
end
