# frozen_string_literal: true

class Loan::FormComponent < ViewComponent::Base
  include LoanFormHelper
  include DS::ComponentHelper

  attr_reader :loan, :account, :form, :options

  def initialize(loan:, account: nil, form: nil, **options)
    @loan = loan
    @account = account || loan.account
    @form = form
    @options = options
  end

  def call
    if use_wizard?
      render_wizard_form
    else
      render_traditional_form
    end
  end

  def render_wizard_form
    content_tag :div, class: "loan-wizard", data: wizard_stimulus_data do
      safe_join([
        wizard_header,
        wizard_steps,
        wizard_content,
        wizard_actions
      ])
    end
  end

  def render_traditional_form
    content_tag :div, class: "space-y-6", data: stimulus_data do
      safe_join([
        lender_details_section,
        loan_terms_section,
        interest_section,
        (schedule_preview_section if show_preview?),
        advanced_details_section
      ].compact)
    end
  end

  private

    def lender_details_section
      section_wrapper(title: t(".lender_details.title")) do
        safe_join([
          render_field(:counterparty_name, field_config(:counterparty_name)),
          conditional_fields(:personal_mode?, personal_loan_fields),
          conditional_fields(:institutional_mode?, institutional_loan_fields)
        ])
      end
    end

    def personal_loan_fields
      visibility_wrapper(:personal) do
        safe_join([
          grid_wrapper do
            safe_join([
              render_field(:relationship, field_config(:relationship)),
              render_field(:linked_contact_id, field_config(:linked_contact_id))
            ])
          end,
          help_text(t(".personal_fields.help"))
        ])
      end
    end

    def institutional_loan_fields
      visibility_wrapper(:institution) do
        safe_join([
          grid_wrapper do
            safe_join([
              render_field(:institution_name, field_config(:institution_name)),
              render_select(:fintech_type, fintech_type_options, field_config(:fintech_type))
            ])
          end,
          grid_wrapper do
            safe_join([
              render_select(:institution_type, institution_type_options, field_config(:institution_type)),
              render_select(:product_type, product_type_options, field_config(:product_type))
            ])
          end
        ])
      end
    end

    def loan_terms_section
      section_wrapper(title: t(".loan_terms.title"), subtitle: t(".loan_terms.subtitle")) do
        safe_join([
          existing_loan_toggle,
          principal_and_date_fields,
          help_text(t(".loan_terms.principal_help")),
          tenor_and_frequency_fields,
          (disbursement_fields unless imported?)
        ].compact)
      end
    end

    # Inform the user about current vs initial balance distinction.
    # Current balance is edited in the account section above (outside the wizard component),
    # while Initial balance lives in this step and represents the original principal at start.
    def existing_loan_toggle
      help_text(
        t(
          ".existing_loan.help",
          default: "If you are onboarding an already-running loan, set the Current balance (outstanding principal today) in the account section below. Initial balance is the amount when the loan originally started."
        )
      )
    end

    def principal_and_date_fields
      grid_wrapper do
        safe_join([
          render_money_field(:initial_balance, field_config(:initial_balance)),
          render_date_field(:start_date, field_config(:start_date))
        ])
      end
    end

    def tenor_and_frequency_fields
      grid_wrapper do
        safe_join([
          render_number_field(:tenor_months, field_config(:tenor_months)),
          render_select(:payment_frequency, payment_frequency_options, field_config(:payment_frequency))
        ])
      end
    end

    def disbursement_fields
      # For personal loans, disbursement account is optional
      return if personal_mode? && available_accounts.empty?

      content_tag :div do
        safe_join([
          grid_wrapper do
            safe_join([
              render_collection_select(:disbursement_account_id, available_accounts, field_config(:disbursement_account_id)),
              render_date_field(:origination_date, field_config(:origination_date))
            ])
          end,
          help_text(t(".disbursement.help"))
        ])
      end
    end

    def interest_section
      section_wrapper(title: t(".interest.title")) do
        safe_join([
          (interest_free_toggle unless sharia_mode?),
          conditional_fields(:conventional_mode?, conventional_interest_fields),
          conditional_fields(:sharia_mode?, islamic_profit_fields)
        ].compact)
      end
    end

    def interest_free_toggle
      toggle_wrapper(
        title: t(".interest_free.title"),
        description: t(".interest_free.description")
      ) do
        render_toggle(:interest_free, field_config(:interest_free))
      end
    end

    def conventional_interest_fields
      target_wrapper(:interestSection, hidden: loan.interest_free?) do
        safe_join([
          grid_wrapper do
            safe_join([
              render_number_field(:interest_rate, field_config(:interest_rate)),
              render_select(:rate_type, rate_type_options, field_config(:rate_type))
            ])
          end,
          render_number_field(:rate_or_profit, field_config(:rate_or_profit))
        ])
      end
    end

    def islamic_profit_fields
      target_wrapper(:profitSection) do
        safe_join([
          render_select(:islamic_product_type, islamic_product_options, field_config(:islamic_product_type)),
          islamic_specific_fields
        ])
      end
    end

    def islamic_specific_fields
      grid_wrapper do
        safe_join([
          conditional_fields(:show_margin_field?, margin_rate_field),
          conditional_fields(:show_profit_sharing_field?, profit_sharing_field)
        ].compact)
      end
    end

    def margin_rate_field
      target_wrapper(:marginField, hidden: !show_margin_field?) do
        render_number_field(:margin_rate, field_config(:margin_rate))
      end
    end

    def profit_sharing_field
      target_wrapper(:profitShareField, hidden: !show_profit_sharing_field?) do
        render_number_field(:profit_sharing_ratio, field_config(:profit_sharing_ratio))
      end
    end

    def schedule_preview_section
      return unless preview_enabled?

      section_wrapper(title: t(".schedule_preview.title"), subtitle: t(".schedule_preview.subtitle")) do
        safe_join([
          preview_button,
          preview_overlay
        ])
      end
    end

    def advanced_details_section
      details_wrapper(title: t(".advanced_details.title")) do
        safe_join([
          render_money_field(:installment_amount, field_config(:installment_amount)),
          calculation_and_balloon_fields,
          help_text(t(".balloon.help"), id: "balloon_help"),
          collateral_and_repayment_fields,
          witness_and_notes_fields,
          render_textarea(:notes, field_config(:notes))
        ])
      end
    end

    def calculation_and_balloon_fields
      grid_wrapper do
        safe_join([
          render_select(:schedule_method, schedule_method_options, field_config(:schedule_method)),
          render_money_field(:balloon_amount, field_config(:balloon_amount))
        ])
      end
    end

    def collateral_and_repayment_fields
      grid_wrapper do
        safe_join([
          render_textarea(:collateral_desc, field_config(:collateral_desc)),
          render_textarea(:early_repayment_policy, field_config(:early_repayment_policy))
        ])
      end
    end

    def witness_and_notes_fields
      grid_wrapper do
        safe_join([
          render_field(:witness_name, field_config(:witness_name)),
          render_textarea(:agreement_notes, field_config(:agreement_notes))
        ])
      end
    end

    def preview_button
      content_tag :div, class: "flex items-center gap-2" do
        render DS::Link.new(
          text: t(".preview.button_text"),
          variant: "secondary",
          icon: "table",
          href: preview_path,
          data: preview_button_data
        )
      end
    end

    def preview_overlay
      content_tag :div, data: overlay_data, class: overlay_classes do
        safe_join([
          overlay_backdrop,
          preview_panel
        ])
      end
    end

    def preview_panel
      content_tag :div, class: panel_classes, data: panel_data do
        safe_join([
          panel_header,
          turbo_frame_tag(preview_frame_id, loading: "lazy")
        ])
      end
    end

    def panel_header
      content_tag :div, class: header_classes do
        safe_join([
          content_tag(:h3, t(".preview.title"), class: "text-base font-semibold text-primary"),
          close_button
        ])
      end
    end

    def close_button
      content_tag :button, icon("x", size: "sm"),
                  type: "button",
                  class: "text-sm text-secondary hover:text-primary",
                  data: { action: "loan-form#closePreview" }
    end

    # Helper method delegates with fallbacks
    def render_field(field_name, config)
      return text_field(field_name, config) if respond_to?(:text_field)
      return form.text_field(field_name, **config) if form.respond_to?(:text_field)

      # Fallback HTML
      "<input type=\"text\" name=\"#{field_name}\" value=\"#{config[:value]}\" class=\"w-full px-3 py-2 border border-secondary rounded-lg\" #{config.except(:label, :value).map { |k, v| "#{k}=\"#{v}\"" }.join(' ')}>"
    end

    def render_money_field(field_name, config)
      return money_field(field_name, config) if respond_to?(:money_field)

      currency = Current.family&.currency || "USD"
      "<input type=\"number\" name=\"#{field_name}\" value=\"#{config[:value]}\" step=\"0.01\" min=\"0\" class=\"w-full px-3 py-2 border border-secondary rounded-lg\" data-currency=\"#{currency}\">"
    end

    def render_number_field(field_name, config)
      return number_field(field_name, config) if respond_to?(:number_field)
      return form.number_field(field_name, **config) if form.respond_to?(:number_field)

      "<input type=\"number\" name=\"#{field_name}\" value=\"#{config[:value]}\" class=\"w-full px-3 py-2 border border-secondary rounded-lg\" #{config.except(:label, :value).map { |k, v| "#{k}=\"#{v}\"" }.join(' ')}>"
    end

    def render_date_field(field_name, config)
      return date_field(field_name, config) if respond_to?(:date_field)
      return form.date_field(field_name, **config) if form.respond_to?(:date_field)

      "<input type=\"date\" name=\"#{field_name}\" value=\"#{config[:value]}\" class=\"w-full px-3 py-2 border border-secondary rounded-lg\" #{config.except(:label, :value).map { |k, v| "#{k}=\"#{v}\"" }.join(' ')}>"
    end

    def render_select(field_name, options, config)
      # Prefer form builder when available
      if form && form.respond_to?(:select)
        opts_cfg, html_cfg = split_select_config(config)
        return form.select(field_name, options || [], opts_cfg, html_cfg)
      end

      opts = Array(options).compact
      cfg = (config || {})
      include_blank = cfg[:include_blank]
      html_attrs = cfg.except(:label, :value, :options, :include_blank, :label_tooltip)

      select_html = "<select name=\"#{field_name}\" class=\"w-full px-3 py-2 border border-secondary rounded-lg\" #{html_attrs.map { |k, v| "#{k}=\"#{v}\"" }.join(' ')}>"
      if include_blank
        blank_label = include_blank == true ? "" : include_blank
        select_html << "<option value=\"\">#{blank_label}</option>"
      end

      select_html << opts.map do |opt|
        if opt.is_a?(Array)
          label, value = opt[0], opt[1]
        else
          label = value = opt
        end
        selected = (value.to_s == cfg[:value].to_s) ? "selected" : ""
        "<option value=\"#{value}\" #{selected}>#{label}</option>"
      end.join

      select_html << "</select>"
      select_html
    end

    def split_select_config(config)
      cfg = (config || {})
      option_keys = [:label, :label_tooltip, :include_blank, :prompt, :selected, :required]
      [ cfg.slice(*option_keys), cfg.except(*option_keys) ]
    end

    def render_collection_select(field_name, collection, config)
      # Prefer form builder when available
      if form && form.respond_to?(:collection_select)
        opts_cfg, html_cfg = split_select_config(config)
        return form.collection_select(field_name, collection || [], :id, :name, opts_cfg, html_cfg)
      end

      col = Array(collection).compact
      cfg = (config || {})
      html_options = cfg[:html_options] || {}
      options_cfg = cfg[:options] || {}

      "<select name=\"#{field_name}\" class=\"w-full px-3 py-2 border border-secondary rounded-lg\" #{html_options.map { |k, v| "#{k}=\"#{v}\"" }.join(' ')}>" +
        col.map do |item|
          value = item.respond_to?(:id) ? item.id : item.to_s
          text = item.respond_to?(:name) ? item.name : item.to_s
          selected = value.to_s == options_cfg[:selected].to_s ? "selected" : ""
          "<option value=\"#{value}\" #{selected}>#{text}</option>"
        end.join +
        "</select>"
    end

    def render_textarea(field_name, config)
      return text_area(field_name, config) if respond_to?(:text_area)
      return form.text_area(field_name, **config) if form.respond_to?(:text_area)

      "<textarea name=\"#{field_name}\" class=\"w-full px-3 py-2 border border-secondary rounded-lg\" #{config.except(:label, :value).map { |k, v| "#{k}=\"#{v}\"" }.join(' ')}>#{config[:value]}</textarea>"
    end

    def render_toggle(field_name, config)
      return toggle(field_name, config) if respond_to?(:toggle)
      return form.toggle(field_name, **config) if form.respond_to?(:toggle)

      "<input type=\"checkbox\" name=\"#{field_name}\" value=\"1\" #{config[:checked] ? 'checked' : ''} class=\"rounded border-gray-300 text-primary focus:ring-primary\">"
    end

    # State predicates
    def personal_mode?
      loan_mode_helper.personal_mode?(loan)
    end

    def institutional_mode?
      loan_mode_helper.institutional_mode?(loan)
    end

    def conventional_mode?
      loan_mode_helper.conventional_mode?(loan)
    end

    def sharia_mode?
      loan_mode_helper.sharia_mode?(loan)
    end

    def imported?
      loan_import_helper.imported?(loan, account)
    end

    def show_margin_field?
      islamic_product_helper.show_margin_field?(loan)
    end

    def show_profit_sharing_field?
      islamic_product_helper.show_profit_sharing_field?(loan)
    end

    def show_preview?
      options[:show_preview] || false
    end

    def preview_enabled?
      loan_feature_helper.preview_enabled?
    end

    def use_wizard?
      options[:wizard] || loan.new_record?
    end

    # Configuration helpers
    def field_config(field_name)
      loan_field_config_helper.config_for(field_name, loan: loan, account: account, form: form)
    end

    def stimulus_data
      loan_stimulus_helper.form_data(account: account, loan: loan)
    end

    # Option helpers
    def fintech_type_options
      loan_options_helper.fintech_type_options
    end

    def institution_type_options
      loan_options_helper.institution_type_options
    end

    def product_type_options
      loan_options_helper.product_type_options
    end

    def payment_frequency_options
      loan_options_helper.payment_frequency_options
    end

    def rate_type_options
      loan_options_helper.rate_type_options
    end

    def islamic_product_options
      loan_options_helper.islamic_product_options
    end

    def schedule_method_options
      loan_options_helper.schedule_method_options
    end

    def available_accounts
      family = Current.family
      return [] unless family

      account_selection_helper.available_accounts_for_disbursement(family)
    rescue
      # Fallback for test environments or when family is not available
      []
    end

    # Layout helpers
    def section_wrapper(title:, subtitle: nil, &block)
      content_tag :section, class: "space-y-3" do
        safe_join([
          content_tag(:h3, title, class: "text-primary font-medium"),
          (content_tag(:p, subtitle, class: "text-xs text-secondary") if subtitle),
          yield
        ].compact)
      end
    end

    def grid_wrapper(&block)
      content_tag :div, class: "grid gap-2 md:grid-cols-2", &block
    end

    def visibility_wrapper(mode, &block)
      content_tag :div,
                  class: visibility_classes(mode),
                  data: visibility_data(mode),
                  &block
    end

    def target_wrapper(target, hidden: false, &block)
      content_tag :div,
                  class: ("hidden" if hidden),
                  data: { "loan-form-target": target.to_s },
                  &block
    end

    def toggle_wrapper(title:, description:, &block)
      content_tag :div, class: toggle_wrapper_classes do
        safe_join([
          content_tag(:div) do
            safe_join([
              content_tag(:p, title, class: "text-sm font-medium text-primary"),
              content_tag(:p, description, class: "text-xs text-secondary")
            ])
          end,
          yield
        ])
      end
    end

    def details_wrapper(title:, &block)
      content_tag :details, class: "space-y-3", data: { "loan-form-target": "advancedSection" } do
        safe_join([
          content_tag(:summary, title, class: "cursor-pointer text-primary font-medium"),
          content_tag(:div, class: "mt-2 space-y-3", &block)
        ])
      end
    end

    def conditional_fields(condition, content)
      content if condition
    end

    def help_text(text, **options)
      content_tag :p, text, class: "text-xs text-secondary", **options
    end

    def overlay_backdrop
      content_tag :div, "",
                  class: "absolute inset-0 bg-black/40",
                  data: { action: "click->loan-form#closePreview" }
    end

    # CSS class helpers
    def visibility_classes(mode)
      classes = "space-y-3"
      classes += " hidden" unless mode_active?(mode)
      classes
    end

    def toggle_wrapper_classes
      "flex items-center justify-between gap-3 rounded-lg border border-dashed border-primary/40 bg-container p-3"
    end

    def overlay_classes
      "fixed inset-0 z-40 hidden items-center justify-center opacity-0 transition-opacity duration-200"
    end

    def panel_classes
      "relative z-10 w-[min(90vw,48rem)] max-h-[80vh] overflow-hidden rounded-2xl border border-primary/30 bg-container shadow-2xl transition duration-200 ease-out scale-95 opacity-0"
    end

    def header_classes
      "flex items-center justify-between border-b border-primary/20 bg-surface px-4 py-3"
    end

    # Data helpers
    def visibility_data(mode)
      {
        "loan-form-target": "visibility",
        "loan-form-visibility-value": mode.to_s
      }
    end

    def overlay_data
      { "loan-form-target": "previewOverlay" }
    end

    def panel_data
      { "loan-form-target": "previewPanel" }
    end

    def preview_button_data
      {
        "loan-form-target": "previewLink",
        action: "click->loan-form#preparePreview"
      }
    end

    # Path helpers
    def preview_path
      loan_path_helper.schedule_preview_path(account)
    end

    def preview_frame_id
      "loan-schedule-preview"
    end

    # Mode helpers
    def mode_active?(mode)
      case mode
      when :personal
        personal_mode?
      when :institution
        institutional_mode?
      else
        true
      end
    end

    # Helper service accessors
    def loan_mode_helper
      @loan_mode_helper ||= LoanModeHelper.new
    end

    def loan_import_helper
      @loan_import_helper ||= LoanImportHelper.new
    end

    def islamic_product_helper
      @islamic_product_helper ||= IslamicProductHelper.new
    end

    def loan_field_config_helper
      @loan_field_config_helper ||= LoanFieldConfigHelper.new
    end

    def loan_stimulus_helper
      @loan_stimulus_helper ||= LoanStimulusHelper.new
    end

    def loan_options_helper
      @loan_options_helper ||= LoanOptionsHelper.new
    end

    def account_selection_helper
      @account_selection_helper ||= AccountSelectionHelper.new
    end

    def loan_path_helper
      @loan_path_helper ||= LoanPathHelper.new
    end

    def loan_feature_helper
      @loan_feature_helper ||= LoanFeatureHelper.new
    end

    def wizard_helper
      @wizard_helper ||= WizardHelper.new
    end

    def personal_mode?
      loan_mode_helper.personal_mode?(loan)
    end

    def institutional_mode?
      loan_mode_helper.institutional_mode?(loan)
    end

    def conventional_mode?
      loan_mode_helper.conventional_mode?(loan)
    end

    def sharia_mode?
      loan_mode_helper.sharia_mode?(loan)
    end

    def imported?
      loan_import_helper.imported?(loan, account)
    end

    def show_margin_field?
      islamic_product_helper.show_margin_field?(loan)
    end

    def show_profit_sharing_field?
      islamic_product_helper.show_profit_sharing_field?(loan)
    end

    def preview_enabled?
      loan_feature_helper.preview_enabled?
    end

    # Wizard-specific methods
    def wizard_header
      content_tag :div, class: "border-b border-primary/20 pb-4 mb-6" do
        safe_join([
          content_tag(:h2, t(".wizard.title"), class: "text-xl font-semibold text-primary"),
          content_tag(:p, t(".wizard.subtitle"), class: "text-sm text-secondary mt-1")
        ])
      end
    end

    def wizard_steps
      content_tag :div, class: "flex items-center justify-between mb-8" do
        safe_join(
          wizard_steps_list.map do |step|
            step_indicator(step)
          end
        )
      end
    end

    def wizard_steps_list
      wizard_helper.steps_list
    end

    def wizard_content
      # Render all steps with data-step-content so the Stimulus controller can toggle visibility
      content_tag :div, class: "min-h-[400px]" do
        safe_join([
          content_tag(:div, render_step_type, data: { step_content: "type" }, style: (current_step == :type ? "" : "display:none;")),
          content_tag(:div, render_step_basic, data: { step_content: "basic" }, style: (current_step == :basic ? "" : "display:none;")),
          content_tag(:div, render_step_terms, data: { step_content: "terms" }, style: (current_step == :terms ? "" : "display:none;")),
          content_tag(:div, render_step_review, data: { step_content: "review" }, style: (current_step == :review ? "" : "display:none;"))
        ])
      end
    end

    def wizard_actions
      content_tag :div, class: "flex items-center justify-between pt-6 border-t border-primary/20" do
        safe_join([
          back_button,
          next_button
        ].compact)
      end
    end

    def step_indicator(step)
      content_tag :div, class: wizard_helper.step_classes(step, current_step, completed_steps), data: { step: step[:key] } do
        safe_join([
          icon(step[:icon], size: "sm"),
          content_tag(:span, step[:title])
        ])
      end
    end

    def render_step_type
      content_tag :div, class: "space-y-6" do
        safe_join([
          content_tag(:h3, t(".type.title"), class: "text-lg font-medium"),
          content_tag(:p, t(".type.description"), class: "text-sm text-secondary"),
          loan_type_selection,
          smart_suggestion
        ])
      end
    end

    def render_step_basic
      content_tag :div, class: "space-y-6" do
        safe_join([
          content_tag(:h3, t(".basic.title"), class: "text-lg font-medium"),
          content_tag(:p, t(".basic.description"), class: "text-sm text-secondary"),
          render_field(:counterparty_name, basic_field_config),
          conditional_basic_fields
        ])
      end
    end

    def render_step_terms
      content_tag :div, class: "space-y-6" do
        safe_join([
          content_tag(:h3, t(".terms.title"), class: "text-lg font-medium"),
          content_tag(:p, t(".terms.description"), class: "text-sm text-secondary"),
          terms_fields,
          smart_rate_suggestion
        ])
      end
    end

    def render_step_review
      content_tag :div, class: "space-y-6" do
        safe_join([
          content_tag(:h3, t(".review.title"), class: "text-lg font-medium"),
          loan_summary,
          schedule_preview,
          confirmation_fields
        ])
      end
    end

    def loan_type_selection
      grid_wrapper do
        safe_join(
          wizard_helper.loan_type_options.map do |type_option|
            loan_type_card(type_option[:key], type_option[:title], type_option[:description])
          end
        )
      end
    end

    def loan_type_card(type, title, description)
      is_selected = loan_type == type.to_s
      classes = "p-4 border rounded-lg cursor-pointer transition-all hover:border-primary/50"
      classes += is_selected ? " border-primary bg-primary/5" : " border-primary/20"

      content_tag :div,
                  class: classes,
                  data: { action: "click->loan-wizard#selectType", "type-value": type } do
        safe_join([
          content_tag(:div, class: "flex items-start gap-3") do
            safe_join([
              render(DS::RadioButton.new(checked: is_selected, name: "loan_type")),
              content_tag(:div) do
                safe_join([
                  content_tag(:h4, title, class: "font-medium text-sm"),
                  content_tag(:p, description, class: "text-xs text-secondary mt-1")
                ])
              end
            ])
          end
        ])
      end
    end

    def smart_suggestion
      content_tag :div, class: "bg-blue-50 border border-blue-200 rounded-lg p-4" do
        safe_join([
          content_tag(:h4, t(".smart_suggestion.title"), class: "font-medium text-blue-900"),
          content_tag(:p, suggestion_text, class: "text-sm text-blue-700 mt-1")
        ])
      end
    end

    def suggestion_text
      wizard_helper.smart_suggestion_for(loan_type)
    end

    def conditional_basic_fields
      return unless loan_type.present?

      if loan_type == "personal"
        personal_basic_fields
      else
        institutional_basic_fields
      end
    end

    def personal_basic_fields
      content_tag :div, class: "space-y-4" do
        safe_join([
          content_tag(:h4, t(".personal_fields.title"), class: "font-medium text-sm"),
          render_field(:relationship, basic_field_config),
          render_field(:linked_contact_id, basic_field_config)
        ])
      end
    end

    def institutional_basic_fields
      content_tag :div, class: "space-y-4" do
        safe_join([
          content_tag(:h4, t(".institutional_fields.title"), class: "font-medium text-sm"),
          render_select(:fintech_type, fintech_type_options, basic_field_config),
          render_field(:institution_name, basic_field_config)
        ])
      end
    end

    def terms_fields
      grid_wrapper do
        safe_join([
          render_money_field(:initial_balance, terms_field_config),
          render_date_field(:start_date, terms_field_config),
          render_number_field(:tenor_months, terms_field_config),
          render_select(:payment_frequency, payment_frequency_options, terms_field_config)
        ])
      end
    end

    def smart_rate_suggestion
      return unless show_rate_suggestion?

      content_tag :div, class: "bg-green-50 border border-green-200 rounded-lg p-4" do
        safe_join([
          content_tag(:h4, t(".rate_suggestion.title"), class: "font-medium text-green-900"),
          content_tag(:p, rate_suggestion_text, class: "text-sm text-green-700 mt-1")
        ])
      end
    end

    # Whether to display the smart rate suggestion info box
    def show_rate_suggestion?
      current_step == :terms
    end

    # Human text for the rate suggestion, computed from component state
    def rate_suggestion_text
      if sharia_mode?
        t("loans.wizard.rate_suggestion.sharia")
      elsif personal_mode?
        t("loans.wizard.rate_suggestion.personal")
      else
        t("loans.wizard.rate_suggestion.institutional")
      end
    end

    def loan_summary
      content_tag :div, class: "bg-surface rounded-lg border p-4" do
        safe_join([
          summary_row(t(".summary.type"), loan_type_label),
          summary_row(t(".summary.amount"), format_loan_amount(loan.initial_balance)),
          summary_row(t(".summary.counterparty"), loan.counterparty_name),
          summary_row(t(".summary.tenor"), format_loan_term(loan.tenor_months)),
          summary_row(t(".summary.interest"), interest_summary)
        ])
      end
    end

    def schedule_preview
      return unless preview_enabled?

      content_tag :div, class: "border rounded-lg p-4" do
        safe_join([
          content_tag(:h4, t(".preview.title"), class: "font-medium mb-3"),
          turbo_frame_tag("loan-schedule-preview", loading: "lazy")
        ])
      end
    end

    def confirmation_fields
      content_tag :div, class: "space-y-4" do
        safe_join([
          disbursement_account_field,
          origination_date_field,
          notes_field
        ])
      end
    end

    def disbursement_account_field
      return if imported?

      # For personal loans, disbursement account is optional
      return unless personal_mode? || available_accounts.any?

      render_collection_select(:disbursement_account_id, available_accounts, review_field_config)
    end

    def origination_date_field
      render_date_field(:origination_date, review_field_config)
    end

    def notes_field
      render_textarea(:notes, review_field_config)
    end

    def back_button
      return if current_step == :type

      render DS::Button.new(
        text: t(".actions.back"),
        variant: "secondary",
        data: { action: "click->loan-wizard#previousStep" }
      )
    end

    def next_button
      render DS::Button.new(
        text: button_text,
        data: { action: "click->loan-wizard#nextOrSubmit" }
      )
    end

    def button_text
      current_step == :review ? t(".actions.create") : t(".actions.next")
    end

    def summary_row(label, value)
      content_tag :div, class: "flex justify-between items-center py-2" do
        safe_join([
          content_tag(:span, label, class: "text-sm text-secondary"),
          content_tag(:span, value, class: "text-sm font-medium")
        ])
      end
    end

    def loan_type_label
      wizard_helper.loan_type_options.find { |opt| opt[:key].to_s == loan_type }&.dig(:title) || loan_type.humanize
    end

    def interest_summary
      if loan.interest_free?
        t(".summary.interest_free")
      elsif sharia_mode?
        "#{loan.effective_rate}% (#{loan.islamic_product_type&.humanize})"
      else
        "#{loan.interest_rate}%"
      end
    end

    # Field configurations
    def basic_field_config
      { class: "w-full" }
    end

    def terms_field_config
      basic_field_config.merge(
        "data-loan-form-target": "principal,tenor,frequency,startDate",
        "data-action": "input->loan-form#termsChanged change->loan-form#termsChanged"
      )
    end

    def review_field_config
      { class: "w-full", rows: 3 }
    end

    def wizard_stimulus_data
      {
        controller: "loan-wizard",
        "loan-wizard-current-step-value": current_step.to_s,
        "loan-wizard-loan-type-value": loan_type
      }
    end

    def current_step
      @current_step ||= (@options[:current_step] || :type)
    end

    def loan_type
      @loan_type ||= (@options[:loan_type] || "personal")
    end

    def completed_steps
      @completed_steps ||= []
    end
end
