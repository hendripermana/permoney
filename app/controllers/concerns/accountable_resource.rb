require "cgi"

module AccountableResource
  extend ActiveSupport::Concern

  included do
    include Periodable

    before_action :set_account, only: [ :show, :edit, :update ]
    before_action :set_link_options, only: :new
  end

  class_methods do
    def permitted_accountable_attributes(*attrs)
      @permitted_accountable_attributes = attrs if attrs.any?
      @permitted_accountable_attributes ||= [ :id ]
    end
  end

  def new
    @account = Current.family.accounts.build(
      currency: Current.family.currency,
      accountable: accountable_type.new
    )
  end

  def show
    @chart_view = params[:chart_view] || "balance"
    @q = params.fetch(:q, {}).permit(:search)
    entries = @account.entries.search(@q).reverse_chronological

    @pagy, @entries = pagy(entries, limit: params[:per_page] || "10")
  end

  def edit
  end

  def create
    @account = Current.family.accounts.create_and_sync(account_params.except(:return_to))
    @account.lock_saved_attributes!

    redirect_to(safe_return_path(account_params[:return_to]) || @account, allow_other_host: false, notice: t("accounts.create.success", type: accountable_type.name.underscore.humanize))
  end

  def update
    # Handle balance update if provided
    if account_params[:balance].present?
      result = @account.set_current_balance(account_params[:balance].to_d)
      unless result.success?
        @error_message = result.error_message
        render :edit, status: :unprocessable_entity
        return
      end
      @account.sync_later
    end

    # Update remaining account attributes
    update_params = account_params.except(:return_to, :balance, :currency)
    unless @account.update(update_params)
      @error_message = @account.errors.full_messages.join(", ")
      render :edit, status: :unprocessable_entity
      return
    end

    @account.lock_saved_attributes!
    redirect_back_or_to account_path(@account), notice: t("accounts.update.success", type: accountable_type.name.underscore.humanize)
  end

  private
    # Only allow internal, recognized paths to be used for redirects.
    # Prevents open redirects and unexpected external navigation even within same host.
    def safe_return_path(candidate)
      return nil if candidate.blank?
      return nil unless candidate.is_a?(String)

      # Only allow absolute application paths (no protocol-relative or external URLs)
      return nil unless candidate.start_with?("/")
      return nil if candidate.start_with?("//")

      # Block control chars and encoded CR/LF to prevent header-splitting
      return nil if candidate.match?(/[[:cntrl:]]/)
      return nil if candidate.match?(/%0d|%0a/i)

      # Decode once and re-check for protocol-relative or dangerous dot-segments
      decoded = begin
        CGI.unescape(candidate)
      rescue StandardError
        candidate
      end

      # Reject protocol-relative after decoding and any obvious scheme prefixes
      return nil if decoded.start_with?("//")
      return nil if decoded.match?(/\A[a-z][a-z0-9+.-]*:/i)

      # Basic dot-segment hardening to avoid odd traversal behaviors
      return nil if decoded.start_with?("/..") || decoded.end_with?("/..")
      return nil if decoded.include?("/../") || decoded.include?("/./")

      begin
        # Recognize only navigable GET routes and prefer request-aware env when present
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
    def set_link_options
      @show_us_link = Current.family.can_connect_plaid_us?
      @show_eu_link = Current.family.can_connect_plaid_eu?
      @show_lunchflow_link = Current.family.can_connect_lunchflow?

      # Preload Lunchflow accounts if available and cache them
      if @show_lunchflow_link
        cache_key = "lunchflow_accounts_#{Current.family.id}"

        @lunchflow_accounts = Rails.cache.fetch(cache_key, expires_in: 5.minutes) do
          begin
            lunchflow_provider = Provider::LunchflowAdapter.build_provider

            if lunchflow_provider.present?
              accounts_data = lunchflow_provider.get_accounts
              accounts_data[:accounts] || []
            else
              []
            end
          rescue Provider::Lunchflow::LunchflowError => e
            Rails.logger.error("Failed to preload Lunchflow accounts: #{e.message}")
            []
          rescue StandardError => e
            Rails.logger.error("Unexpected error preloading Lunchflow accounts: #{e.class}: #{e.message}")
            Rails.logger.error(e.backtrace.join("\n"))
            []
          end
        end
      end
    end

    def accountable_type
      controller_name.classify.constantize
    end

    def set_account
      @account = Current.family.accounts.find(params[:id])
    end

    def account_params
      params.require(:account).permit(
        :name, :balance, :subtype, :currency, :accountable_type, :return_to,
        accountable_attributes: self.class.permitted_accountable_attributes
      )
    end
end
