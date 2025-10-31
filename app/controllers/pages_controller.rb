class PagesController < ApplicationController
  include Periodable

  skip_authentication only: :redis_configuration_error

  def dashboard
    # For self-hosted environments, auto-create a family if user doesn't have one
    # This prevents redirect loops and ensures a valid state, but only if user has completed onboarding
    if Rails.application.config.app_mode.self_hosted? && Current.user && !Current.family && Current.user.onboarding_complete?
      ApplicationRecord.transaction do
        family = Current.user.families.create!(
          name: "#{Current.user.first_name || Current.user.email.split('@').first}'s Family",
          currency: default_currency_for_user,
          country: default_country_for_user,
          locale: I18n.locale.to_s,
          date_format: "%m-%d-%Y",
          timezone: Time.zone.name
        )
        Current.user.update!(family: family)
        log_dashboard_decision("Auto-created family for self-hosted user with currency: #{family.currency}, country: #{family.country}, locale: #{family.locale}")
      end
    end

    unless Current.family
      redirect_to onboarding_path and return
    end
    # Cache expensive balance sheet calculation
    @balance_sheet = Rails.cache.fetch(
      "balance_sheet/#{Current.family.id}/#{Current.family.accounts.maximum(:updated_at)&.to_i}",
      expires_in: 5.minutes
    ) do
      Current.family.balance_sheet
    end

    # Optimize account loading with eager loading
    @accounts = Current.family.accounts.visible.with_attached_logo.includes(:accountable)

    period_param = params[:cashflow_period]
    @cashflow_period = if period_param.present?
      begin
        Period.from_key(period_param)
      rescue Period::InvalidKeyError
        Period.last_30_days
      end
    else
      Period.last_30_days
    end

    family_currency = Current.family.currency

    # Cache expensive income/expense calculations
    cache_key = "income_statement/#{Current.family.id}/#{@cashflow_period.key}/#{Current.family.entries.maximum(:updated_at)&.to_i}"

    income_totals = Rails.cache.fetch("#{cache_key}/income", expires_in: 5.minutes) do
      Current.family.income_statement.income_totals(period: @cashflow_period)
    end

    expense_totals = Rails.cache.fetch("#{cache_key}/expense", expires_in: 5.minutes) do
      Current.family.income_statement.expense_totals(period: @cashflow_period)
    end

    @cashflow_sankey_data = build_cashflow_sankey_data(income_totals, expense_totals, family_currency)

    @breadcrumbs = [ [ "Home", root_path ], [ "Dashboard", nil ] ]
  end

  def changelog
    @release_notes = github_provider.fetch_latest_release_notes

    # Fallback if no release notes are available
    if @release_notes.nil?
      gh = github_provider
      @release_notes = {
        avatar: gh.owner_avatar_url,
        username: gh.owner,
        name: "Release notes unavailable",
        published_at: Date.current,
        body: "<p>Unable to fetch the latest release notes at this time. Please check back later or visit our <a href='#{gh.releases_url}' target='_blank'>GitHub releases page</a> directly.</p>"
      }
    end

    render layout: "settings"
  end

  def feedback
    render layout: "settings"
  end

  def sankey_demo
    # Demo page for responsive Sankey chart
  end

  def carousel_demo
    # Demo page for Box Carousel component
  end

  def redis_configuration_error
    render layout: "blank"
  end

  private
    def github_provider
      Provider::Registry.get_provider(:github)
    end

    # Determine default currency based on user locale, browser headers, or fallback to USD
    def default_currency_for_user
      # Try to determine from user's locale first
      currency_from_locale = currency_from_locale(I18n.locale)
      return currency_from_locale if currency_from_locale

      # Try to determine from browser's Accept-Language header
      currency_from_browser = currency_from_browser_locale
      return currency_from_browser if currency_from_browser

      # Fallback to highest priority currency (USD)
      "USD"
    end

    # Determine default country based on user locale, browser headers, or fallback to US
    def default_country_for_user
      # Try to determine from user's locale first
      country_from_locale = country_from_locale(I18n.locale)
      return country_from_locale if country_from_locale

      # Try to determine from browser's Accept-Language header
      country_from_browser = country_from_browser_locale
      return country_from_browser if country_from_browser

      # Fallback to US
      "US"
    end

    # Map common locales to currencies using existing data sources
    def currency_from_locale(locale)
      # Common locale to currency mappings based on geographical regions
      # This uses knowledge of which currencies are used in which regions
      locale_str = locale.to_s.downcase

      case locale_str
      when /^en[-_]?us?$/, /^en$/
        "USD"
      when /^en[-_]ca$/
        "CAD"
      when /^en[-_]gb$/
        "GBP"
      when /^en[-_]au$/
        "AUD"
      when /^fr[-_]?fr?$/, /^fr$/, /^de[-_]?de?$/, /^de$/, /^es[-_]?es?$/, /^es$/, /^it[-_]?it?$/, /^it$/, /^pt[-_]pt$/, /^nl[-_]?nl?$/, /^nl$/, /^fi[-_]?fi?$/, /^fi$/
        "EUR"
      when /^fr[-_]ca$/
        "CAD"
      when /^de[-_]ch$/, /^fr[-_]ch$/, /^it[-_]ch$/
        "CHF"
      when /^es[-_]mx$/
        "MXN"
      when /^es[-_]ar$/
        "ARS"
      when /^pt[-_]br$/
        "BRL"
      when /^ja[-_]?jp?$/, /^ja$/
        "JPY"
      when /^ko[-_]?kr?$/, /^ko$/
        "KRW"
      when /^zh[-_]?cn?$/, /^zh$/
        "CNY"
      when /^zh[-_]tw$/
        "TWD"
      when /^zh[-_]hk$/
        "HKD"
      when /^ru[-_]?ru?$/, /^ru$/
        "RUB"
      when /^ar[-_]?sa?$/, /^ar$/
        "SAR"
      when /^ar[-_]ae$/
        "AED"
      when /^hi[-_]?in?$/, /^hi$/
        "INR"
      when /^th[-_]?th?$/, /^th$/
        "THB"
      when /^vi[-_]?vn?$/, /^vi$/
        "VND"
      when /^tr[-_]?tr?$/, /^tr$/
        "TRY"
      when /^pl[-_]?pl?$/, /^pl$/
        "PLN"
      when /^sv[-_]?se?$/, /^sv$/
        "SEK"
      when /^no[-_]?no?$/, /^no$/
        "NOK"
      when /^da[-_]?dk?$/, /^da$/
        "DKK"
      else
        nil
      end
    end

    # Map common locales to countries using existing LanguagesHelper data
    def country_from_locale(locale)
      # Use the existing COUNTRY_MAPPING from LanguagesHelper if available
      return nil unless defined?(LanguagesHelper::COUNTRY_MAPPING)

      locale_str = locale.to_s.downcase

      # Extract country code from locale (e.g., "en-US" -> "US", "fr-CA" -> "CA")
      if locale_str.include?("-") || locale_str.include?("_")
        country_code = locale_str.split(/[-_]/).last.upcase
        return country_code if LanguagesHelper::COUNTRY_MAPPING.key?(country_code.to_sym)
      end

      # Fallback mappings for language-only locales
      language_to_country = {
        "en" => "US", "fr" => "FR", "de" => "DE", "es" => "ES", "it" => "IT",
        "pt" => "PT", "ja" => "JP", "ko" => "KR", "zh" => "CN", "ru" => "RU",
        "ar" => "SA", "hi" => "IN", "th" => "TH", "vi" => "VN", "tr" => "TR",
        "pl" => "PL", "nl" => "NL", "sv" => "SE", "no" => "NO", "da" => "DK", "fi" => "FI"
      }

      language = locale_str.split(/[-_]/).first
      country_code = language_to_country[language]
      return country_code if country_code && LanguagesHelper::COUNTRY_MAPPING.key?(country_code.to_sym)

      nil
    end

    # Try to determine currency from browser's Accept-Language header
    def currency_from_browser_locale
      return nil unless request.headers["Accept-Language"]

      # Parse Accept-Language header to get preferred locales
      accepted_locales = request.headers["Accept-Language"]
        .split(",")
        .map { |lang| lang.split(";").first.strip.downcase }
        .first(3) # Only check first 3 preferences

      accepted_locales.each do |locale|
        currency = currency_from_locale(locale)
        return currency if currency
      end

      nil
    end

    # Try to determine country from browser's Accept-Language header
    def country_from_browser_locale
      return nil unless request.headers["Accept-Language"]

      # Parse Accept-Language header to get preferred locales
      accepted_locales = request.headers["Accept-Language"]
        .split(",")
        .map { |lang| lang.split(";").first.strip.downcase }
        .first(3) # Only check first 3 preferences

      accepted_locales.each do |locale|
        country = country_from_locale(locale)
        return country if country
      end

      nil
    end

    def build_cashflow_sankey_data(income_totals, expense_totals, currency_symbol)
      nodes = []
      links = []
      node_indices = {} # Memoize node indices by a unique key: "type_categoryid"

      # Helper to add/find node and return its index
      add_node = ->(unique_key, display_name, value, percentage, color) {
        node_indices[unique_key] ||= begin
          nodes << { name: display_name, value: value.to_f.round(2), percentage: percentage.to_f.round(1), color: color }
          nodes.size - 1
        end
      }

      total_income_val = income_totals.total.to_f.round(2)
      total_expense_val = expense_totals.total.to_f.round(2)

      # --- Create Central Cash Flow Node ---
      cash_flow_idx = add_node.call("cash_flow_node", "Cash Flow", total_income_val, 0, "var(--color-success)")

      # --- Process Income Side (Top-level categories only) ---
      income_totals.category_totals.each do |ct|
        # Skip subcategories – only include root income categories
        next if ct.category.parent_id.present?

        val = ct.total.to_f.round(2)
        next if val.zero?

        percentage_of_total_income = total_income_val.zero? ? 0 : (val / total_income_val * 100).round(1)

        node_display_name = ct.category.name
        node_color = ct.category.color.presence || Category::COLORS.sample

        current_cat_idx = add_node.call(
          "income_#{ct.category.id}",
          node_display_name,
          val,
          percentage_of_total_income,
          node_color
        )

        links << {
          source: current_cat_idx,
          target: cash_flow_idx,
          value: val,
          color: node_color,
          percentage: percentage_of_total_income
        }
      end

      # --- Process Expense Side (Top-level categories only) ---
      expense_totals.category_totals.each do |ct|
        # Skip subcategories – only include root expense categories to keep Sankey shallow
        next if ct.category.parent_id.present?

        val = ct.total.to_f.round(2)
        next if val.zero?

        percentage_of_total_expense = total_expense_val.zero? ? 0 : (val / total_expense_val * 100).round(1)

        node_display_name = ct.category.name
        node_color = ct.category.color.presence || Category::UNCATEGORIZED_COLOR

        current_cat_idx = add_node.call(
          "expense_#{ct.category.id}",
          node_display_name,
          val,
          percentage_of_total_expense,
          node_color
        )

        links << {
          source: cash_flow_idx,
          target: current_cat_idx,
          value: val,
          color: node_color,
          percentage: percentage_of_total_expense
        }
      end

      # --- Process Surplus ---
      leftover = (total_income_val - total_expense_val).round(2)
      if leftover.positive?
        percentage_of_total_income_for_surplus = total_income_val.zero? ? 0 : (leftover / total_income_val * 100).round(1)
        surplus_idx = add_node.call("surplus_node", "Surplus", leftover, percentage_of_total_income_for_surplus, "var(--color-success)")
        links << { source: cash_flow_idx, target: surplus_idx, value: leftover, color: "var(--color-success)", percentage: percentage_of_total_income_for_surplus }
      end

      # Update Cash Flow and Income node percentages (relative to total income)
      if node_indices["cash_flow_node"]
        nodes[node_indices["cash_flow_node"]][:percentage] = 100.0
      end
      # No primary income node anymore, percentages are on individual income cats relative to total_income_val

      { nodes: nodes, links: links, currency_symbol: Money::Currency.new(currency_symbol).symbol }
    end
end
