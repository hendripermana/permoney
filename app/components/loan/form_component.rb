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
    Rails.logger.debug "Rendering wizard form with current_step: #{current_step}"
    content_tag :div, class: "loan-wizard space-y-6", data: wizard_stimulus_data do
      safe_join([
        render_wizard_header,
        render_wizard_content,
        render_wizard_navigation
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
          conditional_fields(:personal_loan?, personal_loan_fields),
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
      return if loan.personal_loan? && available_accounts.empty?

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
      cfg = normalized_config(config)
      return text_field(field_name, cfg) if respond_to?(:text_field)
      return form.text_field(field_name, **builder_options(cfg)) if form&.respond_to?(:text_field)

      html_options = fallback_input_options(field_name, cfg)
      tag.input(**html_options.merge(type: "text", name: loan_param(field_name), value: cfg[:value]).compact)
    end

    def render_money_field(field_name, config)
      cfg = normalized_config(config)
      return money_field(field_name, cfg) if respond_to?(:money_field)

      currency = Current.family&.currency || "USD"
      html_options = fallback_input_options(field_name, cfg, default_classes: "form-input flex-1")
      label_text = cfg[:label] || field_name.to_s.humanize

      content_tag :div, class: "space-y-2" do
        safe_join([
          content_tag(:label, label_text,
                     class: "block text-sm font-medium text-primary",
                     for: html_options[:id]),
          content_tag(:div, class: "flex items-center gap-2") do
            data_attrs = merge_currency_data(html_options.delete(:data), currency)
            number_input = tag.input(**html_options.merge(type: "number",
                                                         name: loan_param(field_name),
                                                         value: cfg[:value],
                                                         step: cfg[:step] || "0.01",
                                                         min: cfg[:min] || "0",
                                                         placeholder: cfg[:placeholder] || "0.00",
                                                         data: data_attrs).compact)

            safe_join([
              content_tag(:span, currency_symbol(currency),
                         class: "text-sm text-secondary px-2 py-1 bg-surface border border-secondary rounded-l-lg"),
              number_input
            ])
          end
        ].compact)
      end
    end

    def render_number_field(field_name, config)
      cfg = normalized_config(config)
      return number_field(field_name, cfg) if respond_to?(:number_field)
      return form.number_field(field_name, **builder_options(cfg)) if form&.respond_to?(:number_field)

      html_options = fallback_input_options(field_name, cfg)
      label_text = cfg[:label] || field_name.to_s.humanize

      content_tag :div, class: "space-y-2" do
        safe_join([
          content_tag(:label, label_text,
                     class: "block text-sm font-medium text-primary",
                     for: html_options[:id]),
          tag.input(**html_options.merge(type: "number",
                                        name: loan_param(field_name),
                                        value: cfg[:value],
                                        placeholder: cfg[:placeholder]).compact)
        ])
      end
    end

    def render_date_field(field_name, config)
      cfg = normalized_config(config)
      return date_field(field_name, cfg) if respond_to?(:date_field)
      return form.date_field(field_name, **builder_options(cfg)) if form&.respond_to?(:date_field)

      html_options = fallback_input_options(field_name, cfg)
      label_text = cfg[:label] || field_name.to_s.humanize

      content_tag :div, class: "space-y-2" do
        safe_join([
          content_tag(:label, label_text,
                     class: "block text-sm font-medium text-primary",
                     for: html_options[:id]),
          content_tag(:div, class: "relative") do
            safe_join([
              tag.input(**html_options.merge(type: "date",
                                             name: loan_param(field_name),
                                             value: cfg[:value]).compact),
              content_tag(:div, class: "absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none") do
                icon("calendar", size: :sm, class: "text-secondary")
              end
            ])
          end
        ])
      end
    end

    def render_select(field_name, options, config)
      if form&.respond_to?(:select)
        opts_cfg, html_cfg = split_select_config(config)
        return form.select(field_name, options || [], opts_cfg, html_cfg)
      end

      cfg = normalized_config(config)
      options_cfg, html_cfg = split_select_config(cfg)
      html_options = fallback_input_options(field_name, html_cfg, default_classes: "form-input w-full")

      selected_value = options_cfg[:selected] || cfg[:value]
      option_tags = options_for_select(Array(options).compact, selected_value)
      if options_cfg[:include_blank] || options_cfg[:prompt]
        blank_label = options_cfg[:prompt] || (options_cfg[:include_blank] == true ? "" : options_cfg[:include_blank])
        option_tags = content_tag(:option, blank_label, value: "") + option_tags
      end

      content_tag(:select, option_tags,
                  **html_options.merge(name: loan_param(field_name)))
    end

    def split_select_config(config)
      cfg = normalized_config(config)
      option_keys = [ :label, :label_tooltip, :include_blank, :prompt, :selected, :required ]
      [ cfg.slice(*option_keys), cfg.except(*option_keys) ]
    end

    def render_collection_select(field_name, collection, config)
      if form&.respond_to?(:collection_select)
        opts_cfg, html_cfg = split_select_config(config)
        return form.collection_select(field_name, collection || [], :id, :name, opts_cfg, html_cfg)
      end

      cfg = normalized_config(config)
      options_cfg, html_cfg = split_select_config(cfg)
      html_options = fallback_input_options(field_name, html_cfg, default_classes: "form-input w-full")

      selected_value = options_cfg[:selected] || cfg[:value]
      option_tags = options_from_collection_for_select(Array(collection).compact, :id, :name, selected_value)
      if options_cfg[:include_blank] || options_cfg[:prompt]
        blank_label = options_cfg[:prompt] || (options_cfg[:include_blank] == true ? "" : options_cfg[:include_blank])
        option_tags = content_tag(:option, blank_label, value: "") + option_tags
      end

      content_tag(:select, option_tags,
                  **html_options.merge(name: loan_param(field_name)))
    end

    def render_textarea(field_name, config)
      cfg = normalized_config(config)
      return text_area(field_name, cfg) if respond_to?(:text_area)
      return form.text_area(field_name, **builder_options(cfg)) if form&.respond_to?(:text_area)

      html_options = fallback_input_options(field_name, cfg, default_classes: "form-input w-full")
      content_tag(:textarea, cfg[:value],
                  **html_options.merge(name: loan_param(field_name)))
    end

    def render_toggle(field_name, config)
      cfg = normalized_config(config)
      return toggle(field_name, cfg) if respond_to?(:toggle)
      return form.toggle(field_name, **builder_options(cfg)) if form&.respond_to?(:toggle)

      html_options = fallback_input_options(field_name, cfg, default_classes: "rounded border-secondary")
      checked_flag = cfg[:checked] ? "checked" : nil
      tag.input(**html_options.merge(type: "checkbox",
                                     name: loan_param(field_name),
                                     value: "1",
                                     checked: checked_flag).compact)
    end

    def render_radio_button(field_name, value, config = {})
      cfg = normalized_config(config)
      return form.radio_button(field_name, value, **builder_options(cfg)) if form&.respond_to?(:radio_button)

      id = cfg.delete(:id) || "loan_#{field_name}_#{value}"
      class_name = cfg.delete(:class)
      data_attrs = cfg.delete(:data)
      checked_flag = cfg.delete(:checked)

      attributes = {
        type: "radio",
        name: loan_param(field_name),
        id: id,
        value: value
      }

      attributes[:class] = class_name if class_name.present?
      attributes[:data] = normalize_data_attributes(data_attrs) if data_attrs.present?
      attributes[:checked] = "checked" if checked_flag

      attributes.merge!(cfg)

      tag.input(**attributes.compact)
    end

    # State predicates (defined in helper methods above)

    def show_preview?
      ActiveModel::Type::Boolean.new.cast(options[:show_preview])
    end

    def preview_enabled?
      show_preview? && loan_feature_helper.preview_enabled?
    end

    def use_wizard?
      options[:wizard] || loan.new_record?
    end

    def personal_loan?
      loan.personal_loan?
    end

    def institutional_mode?
      loan_import_helper.institutional_mode?(loan)
    end

    def conventional_mode?
      loan_import_helper.conventional_mode?(loan)
    end

    def sharia_mode?
      loan_mode_helper.sharia_mode?(loan)
    end

    def imported?
      loan_import_helper.imported?(loan, account)
    end

    # Configuration helpers
    def field_config(field_name, overrides = {})
      base = loan_field_config(field_name, loan: loan, account: account, form: form)
      base = (base.present? ? base.deep_dup : {})
      base.merge!(overrides) if overrides.present?
      base
    end

    def stimulus_data
      loan_stimulus_helper.form_data(account: account, loan: loan, preview_enabled: preview_enabled?)
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
      check = condition
      check = send(condition) if condition.is_a?(Symbol)
      content if check
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
        loan.personal_loan?
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

    # Wizard-specific methods
    def render_wizard_header
      content_tag :div, class: "mb-6" do
        safe_join([
          content_tag(:div, class: "mb-4") do
            safe_join([
              content_tag(:h2, "Create loan", class: "text-xl font-bold text-primary"),
              content_tag(:p, "Set up your loan details step by step", class: "text-sm text-subtle mt-1")
            ])
          end,
          render_progress_steps
        ])
      end
    end

    def render_progress_steps
      steps = [
        { key: :type, label: "Loan type", icon: "user" },
        { key: :basic, label: "Details", icon: "edit" },
        { key: :terms, label: "Terms", icon: "calculator" },
        { key: :review, label: "Review", icon: "check-circle" }
      ]

      content_tag :div, class: "wizard-steps-container relative flex items-center justify-between" do
        safe_join([
          # Render background connector line
          render_background_connector(steps.size),
          # Render step indicators
          content_tag(:div, class: "relative flex items-center justify-between w-full z-10") do
            steps.map.with_index do |step, index|
              render_step_indicator(step, index, steps.size)
            end.join.html_safe
          end
        ])
      end
    end

    def render_step_indicator(step, index, total_steps)
      current_index = get_current_step_index
      is_active = index == current_index
      is_completed = index < current_index

      # Clean step indicator without extra spacing issues
      content_tag :div,
                  class: "flex flex-col items-center relative z-20 step-indicator transition-all duration-300",
                  data: {
                    "loan-wizard-target": "stepIndicator",
                    step_index: index,
                    step_name: step[:key]
                  } do
        safe_join([
          # Step circle with proper positioning
          content_tag(:div,
                     class: step_circle_classes(is_active, is_completed),
                     data: { "loan-wizard-target": "stepCircle" }) do
            if is_completed
              icon("check", size: :sm, class: "text-white")
            else
              content_tag(:span, (index + 1).to_s, class: "text-sm font-medium")
            end
          end,
          # Step label with proper spacing
          content_tag(:div, class: "mt-3 text-center") do
            safe_join([
              content_tag(:span, step[:label], class: step_label_classes(is_active)),
              (content_tag(:div, "", class: "w-1 h-1 bg-success rounded-full mx-auto mt-1") if is_active)
            ].compact)
          end
        ])
      end
    end

    def step_circle_classes(is_active, is_completed)
      base = "w-8 h-8 rounded-full flex items-center justify-center transition-all duration-300 transform"

      if is_completed
        "#{base} bg-success text-white shadow-md scale-110 ring-2 ring-success/20"
      elsif is_active
        "#{base} bg-success text-white shadow-lg scale-110 ring-4 ring-success/30 animate-pulse"
      else
        "#{base} bg-container border-2 border-secondary text-secondary hover:border-success/40 hover:bg-container-hover hover:text-primary"
      end
    end

    def step_label_classes(is_active)
      base = "text-xs mt-2 transition-all duration-200"
      if is_active
        "#{base} font-semibold text-success"
      else
        "#{base} text-secondary hover:text-primary"
      end
    end

    def render_background_connector(total_steps)
      content_tag :div, class: "absolute inset-x-0 top-4 h-1 z-0 flex items-center px-8" do
        safe_join([
          # Background line that spans between step circles
          content_tag(:div, "", class: "flex-1 h-full bg-secondary rounded-full"),
          # Progress line that fills based on current step
          content_tag(:div, "",
                     class: "absolute left-8 right-8 h-full bg-gradient-to-r from-success to-success/90 rounded-full transition-all duration-700 ease-out origin-left",
                     style: "transform: scaleX(#{calculate_connector_progress / 100.0})",
                     data: { "loan-wizard-target": "progressBar" }),
          # Glow effect for active progress
          content_tag(:div, "",
                     class: "absolute left-8 right-8 h-full bg-success/20 rounded-full blur-sm transition-all duration-700 origin-left",
                     style: "transform: scaleX(#{calculate_connector_progress / 100.0}); opacity: #{calculate_connector_progress > 0 ? '1' : '0'};")
        ])
      end
    end

    def render_step_connector
      # This method is now replaced by render_background_connector
      # Keeping for backward compatibility
      ""
    end

    def render_step_header(title, subtitle = nil, description = nil)
      content_tag :div, class: "mb-6 pb-4 border-b border-secondary" do
        safe_join([
          content_tag(:h3, title, class: "text-lg font-medium text-primary mb-1"),
          (content_tag(:p, subtitle, class: "text-sm text-primary") if subtitle.presence),
          (content_tag(:p, description, class: "text-sm text-secondary mt-1") if description.presence)
        ].compact)
      end
    end


    def calculate_progress_width
      current_index = get_current_step_index
      return 0 if current_index == 0
      (current_index.to_f / 3 * 100).round
    end

    def calculate_connector_progress
      current_index = get_current_step_index
      return 0 if current_index == 0

      # Calculate progress between step circles (0-100%)
      # Step 1 -> 2: 33%, Step 2 -> 3: 66%, Step 3 -> 4: 100%
      (current_index.to_f / 3 * 100).round
    end

    def render_wizard_navigation
      content_tag :div, class: "flex items-center justify-between pt-6 mt-8 border-t border-secondary" do
        safe_join([
          render_back_button,
          render_next_button
        ])
      end
    end

    def render_back_button
      # Always render back button, let JavaScript handle visibility
      content_tag :button,
                  type: "button",
                  class: "flex items-center space-x-2 px-4 py-2 text-secondary hover:text-primary transition-all duration-200 hover:bg-container-hover rounded-lg border border-secondary hover:border-primary/40",
                  data: {
                    action: "click->loan-wizard#previousStep",
                    "loan-wizard-target": "backButton"
                  } do
        safe_join([
          icon("chevron-left", size: :sm),
          content_tag(:span, "Back", class: "font-medium")
        ])
      end
    end

    def render_next_button
      current_index = get_current_step_index
      is_last_step = current_index == 3

      button_classes = "px-6 py-3 button-bg-primary fg-inverse rounded-lg hover:button-bg-primary-hover transition-all duration-200 font-medium shadow-md hover:shadow-lg transform hover:scale-105"

      if is_last_step
        if form&.respond_to?(:submit)
          form.submit t("loans.actions.create", default: "Create loan"), class: button_classes
        else
          tag.button t("loans.actions.create", default: "Create loan"),
                     type: "submit",
                     class: button_classes
        end
      else
        content_tag :button,
                   type: "button",
                   class: "flex items-center space-x-2 #{button_classes}",
                   data: { action: "click->loan-wizard#nextStep" } do
          safe_join([
            content_tag(:span, t("loans.actions.next", default: "Next")),
            icon("chevron-right", size: :sm)
          ])
        end
      end
    end

    def get_current_step_index
      case current_step
      when :type then 0
      when :basic then 1
      when :terms then 2
      when :review then 3
      else 0
      end
    end


    def render_wizard_content
      # Render all steps with data-step-content so the Stimulus controller can toggle visibility
      # Always show the first step initially, JavaScript will handle the rest
      content_tag :div, class: "min-h-[400px]" do
        safe_join([
          content_tag(:div, render_step_type, data: { step_content: "type" }, style: (current_step == :type ? "" : "display:none;")),
          content_tag(:div, render_step_basic, data: { step_content: "basic" }, style: "display:none;"),
          content_tag(:div, render_step_terms, data: { step_content: "terms" }, style: "display:none;"),
          content_tag(:div, render_step_review, data: { step_content: "review" }, style: "display:none;")
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
          render_step_header(
            t("loans.wizard.steps.type", default: "Loan type"),
            t("loans.wizard.type.prompt", default: "What type of loan is this?"),
            t("loans.wizard.type.help", default: "Choose the counterparty type below and fill in the relevant details.")
          ),
          loan_type_selection,
          smart_suggestion
        ])
      end
    end

    def render_step_basic
      content_tag :div, class: "space-y-6" do
        safe_join([
          render_step_header(
            t("loans.wizard.steps.basic", default: "Basic information"),
            t("loans.wizard.basic.title", default: "Loan details"),
            t("loans.wizard.basic.description", default: "Enter the basic information about your loan. Fields will appear based on your loan type selection from step 1.")
          ),
          render_current_loan_type_indicator,
          content_tag(:div, class: "space-y-2") do
            safe_join([
              content_tag(:label, "Lender name", class: "block text-sm font-medium text-primary", for: "loan_counterparty_name"),
              render_field(:counterparty_name, field_config(
                :counterparty_name,
                id: "loan_counterparty_name",
                placeholder: "e.g., Ana, Bank Mandiri, John Doe",
                required: true
              ))
            ])
          end,
          render_dynamic_basic_fields
        ])
      end
    end

    def render_step_terms
      content_tag :div, class: "space-y-6" do
        safe_join([
          render_step_header(
            t("loans.wizard.steps.terms", default: "Loan terms"),
            t("loans.wizard.terms.title", default: "Configure the payment terms"),
            t("loans.wizard.terms.description", default: "Configure the payment terms and interest rate")
          ),
          terms_fields,
          smart_rate_suggestion
        ])
      end
    end

    def render_step_review
      content_tag :div, class: "space-y-6" do
        safe_join([
          render_step_header(
            t("loans.wizard.steps.review", default: "Review & confirm"),
            t("loans.wizard.review.title", default: "Review your loan details"),
            t("loans.wizard.review.description", default: "Review your loan details before creating")
          ),
          loan_summary,
          schedule_preview,
          confirmation_fields
        ])
      end
    end

    def loan_type_selection
      content_tag :div, class: "grid grid-cols-1 md:grid-cols-2 gap-4" do
        safe_join([
          loan_type_card("personal", "Personal loan", "Borrowing from family, friends, or colleagues"),
          loan_type_card("institutional", "Institutional loan", "Borrowing from banks, fintech, or other institutions")
        ])
      end
    end

    def loan_type_card(type, title, description)
      selected = (loan.debt_kind || "personal") == type.to_s

      content_tag :label,
                  class: loan_type_card_classes(selected),
                  for: "loan_debt_kind_#{type}",
                  data: {
                    action: "click->loan-wizard#selectLoanType",
                    "loan-type": type,
                    "loan-wizard-target": "loanTypeCard"
                  } do
        safe_join([
          render_radio_button(:debt_kind, type,
                              class: "peer sr-only",
                              checked: selected,
                              id: "loan_debt_kind_#{type}",
                              data: { "loan-wizard-target": "loanTypeRadio" }),
          content_tag(:div, class: "flex items-start gap-4 px-4 py-4") do
            safe_join([
              content_tag(:div,
                          class: loan_type_icon_container_classes(selected),
                          data: { "loan-type-role": "icon" }) do
                icon(icon_name_for_type(type),
                     size: :lg,
                     class: loan_type_icon_classes(selected))
              end,
              content_tag(:div, class: "flex-1") do
                safe_join([
                  content_tag(:h4, title, class: "font-semibold text-primary transition-colors duration-200"),
                  content_tag(:p, description, class: "text-sm text-secondary mt-1 leading-relaxed")
                ])
              end,
              selection_indicator(selected)
            ])
          end
        ])
      end
    end

    def loan_type_card_classes(selected)
      class_names(
        "loan-type-card block cursor-pointer rounded-lg border border-secondary bg-container transition-all duration-200 hover:border-primary/40 hover:shadow-sm",
        ("border-primary bg-primary/5 ring-2 ring-primary/15 shadow-sm" if selected)
      )
    end

    def loan_type_icon_container_classes(selected)
      class_names(
        "loan-type-icon icon-container p-3 rounded-lg bg-surface transition-colors duration-200",
        ("bg-primary/10" if selected)
      )
    end

    def loan_type_icon_classes(selected)
      class_names(
        "transition-colors duration-200 text-secondary",
        ("text-primary" if selected)
      )
    end

    def selection_indicator(selected)
      container_classes = class_names(
        "loan-type-indicator hidden w-6 h-6 items-center justify-center rounded-full border border-secondary text-secondary transition-all duration-200",
        ("flex border-primary bg-primary/10 text-primary" if selected)
      )

      content_tag :div,
                  class: container_classes,
                  data: { "loan-type-role": "indicator" } do
        icon("check", size: :sm, class: "h-4 w-4")
      rescue
        content_tag :span, "✓", class: "text-sm font-semibold"
      end
    end

    def icon_name_for_type(type)
      case type
      when "personal" then "users"
      when "institutional" then "building-2"
      else "circle"
      end
    end

    def smart_suggestion
      body = content_tag(:div, class: "flex items-start justify-between gap-3") do
        safe_join([
          content_tag(:div, class: "flex items-start gap-3") do
            safe_join([
              icon("lightbulb", size: :sm, class: "text-primary mt-0.5"),
              content_tag(:div) do
                safe_join([
                  content_tag(:h4, "Tip: Personal loans are often interest-free", class: "font-medium text-primary text-sm"),
                  content_tag(:p, "Family and friends usually don't charge interest. You can set this up as 0% interest with flexible payment terms.", class: "text-sm text-secondary mt-1")
                ])
              end
            ])
          end,
          render(DS::Button.new(
            text: "Apply",
            size: :sm,
            variant: :primary,
            data: { action: "click->loan-wizard#applyQuickSetup" }
          ))
        ])
      end

      render DS::Alert.new(message: body, variant: :info)
    end

    def render_current_loan_type_indicator
      loan_type = loan.debt_kind || "personal"
      type_info = case loan_type
      when "personal"
        { title: "Personal Loan", description: "Borrowing from family, friends, or colleagues", icon: "users", color: "green" }
      when "institutional"
        { title: "Institutional Loan", description: "Borrowing from banks, fintech, or other institutions", icon: "building-2", color: "blue" }
      else
        { title: "Loan", description: "Please select loan type in step 1", icon: "circle", color: "gray" }
      end

      content_tag :div, class: "bg-#{type_info[:color]}-50 theme-dark:bg-#{type_info[:color]}-900/20 border border-#{type_info[:color]}-200 theme-dark:border-#{type_info[:color]}-700 rounded-lg p-3" do
        safe_join([
          content_tag(:div, class: "flex items-center gap-3") do
            safe_join([
              icon(type_info[:icon], size: :sm, class: "text-#{type_info[:color]}-600 theme-dark:text-#{type_info[:color]}-400"),
              content_tag(:div) do
                safe_join([
                  content_tag(:h4, "Selected: #{type_info[:title]}", class: "font-medium text-#{type_info[:color]}-900 theme-dark:text-#{type_info[:color]}-100 text-sm"),
                  content_tag(:p, type_info[:description], class: "text-xs text-#{type_info[:color]}-700 theme-dark:text-#{type_info[:color]}-200")
                ])
              end,
              content_tag(:button,
                         "Change",
                         type: "button",
                         class: "text-xs text-#{type_info[:color]}-600 hover:text-#{type_info[:color]}-800 underline",
                         data: { action: "click->loan-wizard#goToStep1" })
            ])
          end
        ])
      end
    end

    def suggestion_text
      "Quick setup for personal loans with 0% interest and flexible terms"
    end

    def relationship_options
      [
        [ "Family member", "family" ],
        [ "Friend", "friend" ],
        [ "Colleague", "colleague" ],
        [ "Business partner", "business_partner" ],
        [ "Other", "other" ]
      ]
    end

    def fintech_type_options
      Loan::FINTECH_TYPES.map { |key, meta| [ meta[:long], key ] }
    end

    def institution_type_options
      Loan::INSTITUTION_TYPES.map { |type| [ type.titleize, type ] }
    end

    def render_dynamic_basic_fields
      # Show both personal and institutional fields, let JavaScript handle visibility
      content_tag :div, class: "space-y-4" do
        safe_join([
          # Personal loan fields
          content_tag(:div,
                     class: "space-y-4",
                     data: { "loan-type": "personal", "loan-wizard-target": "personalFields" },
                     style: (loan.debt_kind == "personal" ? "" : "display: none;")) do
            safe_join([
              content_tag(:h4, "Personal loan details", class: "font-medium text-primary"),
              content_tag(:div, class: "grid grid-cols-1 md:grid-cols-2 gap-4") do
                safe_join([
                  content_tag(:div, class: "space-y-1") do
                    safe_join([
                      content_tag(:label, "Relationship", class: "block text-sm font-medium text-primary", for: "loan_relationship"),
                      render_field(:relationship, field_config(
                        :relationship,
                        id: "loan_relationship",
                        placeholder: "e.g., Friend, Family, Colleague"
                      ))
                    ])
                  end,
                  content_tag(:div, class: "space-y-1") do
                    safe_join([
                      content_tag(:label, "Contact (optional)", class: "block text-sm font-medium text-primary", for: "loan_contact"),
                      render_field(:linked_contact_id, field_config(
                        :linked_contact_id,
                        id: "loan_contact",
                        placeholder: "+62-812-1234-5678",
                        required: false
                      ))
                    ])
                  end
                ])
              end,
              content_tag(:p, "Add a phone number to set reminders for payments", class: "text-xs text-secondary")
            ])
          end,

          # Institutional loan fields
          content_tag(:div,
                     class: "space-y-4",
                     data: { "loan-type": "institutional", "loan-wizard-target": "institutionalFields" },
                     style: (loan.debt_kind == "institutional" ? "" : "display: none;")) do
            safe_join([
              content_tag(:h4, "Institutional loan details", class: "font-medium text-primary"),
              content_tag(:div, class: "grid grid-cols-1 md:grid-cols-2 gap-4") do
                safe_join([
                  content_tag(:div, class: "space-y-1") do
                    safe_join([
                      content_tag(:label, "Institution type", class: "block text-sm font-medium text-primary", for: "loan_fintech_type"),
                      render_select(:fintech_type, fintech_type_options, field_config(
                        :fintech_type,
                        id: "loan_fintech_type",
                        prompt: "Select type..."
                      ))
                    ])
                  end,
                  content_tag(:div, class: "space-y-1") do
                    safe_join([
                      content_tag(:label, "Institution name", class: "block text-sm font-medium text-primary", for: "loan_institution_name"),
                      render_field(:institution_name, field_config(
                        :institution_name,
                        id: "loan_institution_name",
                        placeholder: "e.g., Bank Mandiri, BCA"
                      ))
                    ])
                  end
                ])
              end
            ])
          end
        ])
      end
    end

    def conditional_basic_fields
      # Deprecated - use render_dynamic_basic_fields instead
      render_dynamic_basic_fields
    end

    def personal_basic_fields
      content_tag :div, class: "space-y-4", data: { loan_type: "personal" } do
        safe_join([
          content_tag(:h4, "Personal loan details", class: "font-medium text-primary"),
          content_tag(:div, class: "grid grid-cols-1 md:grid-cols-2 gap-4") do
            safe_join([
              render_field(:relationship, field_config(:relationship, label: "Relationship", placeholder: "e.g., Friend, Family")),
              render_field(:linked_contact_id, field_config(:linked_contact_id, label: "Contact (optional)", placeholder: "+62-812-1234-5678"))
            ])
          end,
          content_tag(:p, "Add a phone number to set reminders for payments", class: "text-xs text-secondary")
        ])
      end
    end

    def institutional_basic_fields
      content_tag :div, class: "space-y-4", data: { loan_type: "institutional" } do
        safe_join([
          content_tag(:h4, "Institutional loan details", class: "font-medium text-primary"),
          content_tag(:div, class: "grid grid-cols-1 md:grid-cols-2 gap-4") do
            safe_join([
              render_select(:fintech_type, fintech_type_options, field_config(:fintech_type, label: "Institution type", prompt: "Select type...")),
              render_field(:institution_name, field_config(:institution_name, label: "Institution name", placeholder: "e.g., Bank Mandiri"))
            ])
          end
        ])
      end
    end

    def terms_fields
      content_tag :div, class: "space-y-6" do
        safe_join([
          # Principal amount - full width
          content_tag(:div, class: "space-y-2") do
            safe_join([
              content_tag(:label, "Principal amount", class: "block text-sm font-medium text-primary"),
              render_money_field(:principal_amount, field_config(:principal_amount, label: nil))
            ])
          end,

          # Two column grid for other fields
          content_tag(:div, class: "grid grid-cols-1 md:grid-cols-2 gap-4") do
            safe_join([
              content_tag(:div, class: "space-y-2") do
                safe_join([
                  content_tag(:label, "Loan term (months)", class: "block text-sm font-medium text-primary"),
                  render_number_field(:term_months, field_config(:term_months, label: nil, placeholder: "12"))
                ])
              end,
              content_tag(:div, class: "space-y-2") do
                safe_join([
                  content_tag(:label, "Payment frequency", class: "block text-sm font-medium text-primary"),
                  render_select(:payment_frequency, payment_frequency_options, field_config(:payment_frequency, label: nil))
                ])
              end
            ])
          end,

          # Interest rate section
          content_tag(:div, class: "space-y-4") do
            safe_join([
              content_tag(:div, class: "flex items-center gap-3") do
                safe_join([
                  content_tag(:input, nil,
                             type: "checkbox",
                             id: "loan_interest_free",
                             name: "loan[interest_free]",
                             class: "w-4 h-4 text-success bg-container border-secondary rounded focus:ring-success focus:ring-2",
                             data: { action: "change->loan-wizard#toggleInterestRate" }),
                  content_tag(:label, "Interest-free loan",
                             class: "text-sm font-medium text-primary cursor-pointer",
                             for: "loan_interest_free")
                ])
              end,
              content_tag(:div, class: "space-y-2", data: { "loan-wizard-target": "interestRateSection" }) do
                safe_join([
                  content_tag(:label, "Interest rate (%)", class: "block text-sm font-medium text-primary"),
                  render_number_field(:interest_rate, field_config(:interest_rate, label: nil, placeholder: "0.0", step: "0.1", min: "0"))
                ])
              end
            ])
          end
        ])
      end
    end

    def smart_rate_suggestion
      # Keep simple and robust: only show on the 'terms' step
      return unless current_step == :terms

      body = safe_join([
        content_tag(:h4, t(".rate_suggestion.title", default: "Rate suggestion"), class: "font-medium text-primary"),
        content_tag(:p, rate_suggestion_text, class: "text-sm text-secondary mt-1")
      ])

      render DS::Alert.new(message: body, variant: :success)
    end

    # Whether to display the smart rate suggestion info box
    def show_rate_suggestion?
      current_step == :terms
    end

    # Human text for the rate suggestion, computed from component state
    def rate_suggestion_text
      if sharia_mode?
        t("loans.wizard.rate_suggestion.sharia")
      elsif loan.personal_loan?
        t("loans.wizard.rate_suggestion.personal")
      else
        t("loans.wizard.rate_suggestion.institutional")
      end
    end

    def loan_summary
      content_tag :div, class: "bg-surface rounded-lg border border-secondary p-4" do
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

      content_tag :div, class: "border border-secondary rounded-lg p-4" do
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
      return unless loan.personal_loan? || available_accounts.any?

      render_collection_select(:disbursement_account_id, available_accounts, field_config(:disbursement_account_id))
    end

    def origination_date_field
      render_date_field(:origination_date, field_config(:origination_date))
    end

    def notes_field
      render_textarea(:notes, field_config(:notes, rows: 3))
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

    def currency_symbol(currency_code)
      case currency_code.to_s.upcase
      when "IDR" then "Rp"
      when "USD" then "$"
      when "EUR" then "€"
      when "GBP" then "£"
      when "JPY" then "¥"
      else currency_code.to_s
      end
    end

    def loan_type_label
      wizard_helper.loan_type_options.find { |opt| opt[:key].to_s == loan_type }&.dig(:title) || loan_type.humanize
    end

    def interest_summary
      if loan.interest_free?
        t(".summary.interest_free")
      elsif loan.sharia_compliant?
        "#{loan.effective_rate}% (#{loan.islamic_product_type&.humanize})"
      else
        "#{loan.interest_rate}%"
      end
    end

    def wizard_stimulus_data
      {
        controller: "loan-wizard",
        "loan-wizard-current-step-value": current_step.to_s,
        "loan-wizard-total-steps-value": 4,
        "loan-wizard-loan-type-value": loan.debt_kind || "personal"
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

    def normalized_config(config)
      (config || {}).deep_dup
    end

    def builder_options(config)
      normalized_config(config)
    end

    def fallback_input_options(field_name, config, default_classes: "form-input w-full")
      options = normalized_config(config).except(:label, :value, :label_tooltip, :help_text, :options, :include_blank, :prompt, :selected)
      options[:id] ||= "loan_#{field_name}_#{SecureRandom.hex(6)}"
      options[:class] = combine_classes(default_classes, options[:class])

      data_attrs = options.delete(:data)
      options[:data] = normalize_data_attributes(data_attrs) if data_attrs.present?

      options
    end

    def normalize_data_attributes(data_attrs)
      (data_attrs || {}).each_with_object({}) do |(key, value), memo|
        memo[(key.to_s.tr("_", "-") rescue key)] = value
      end
    end

    def combine_classes(*classes)
      classes.flatten.compact.map { |value| value.respond_to?(:strip) ? value.strip : value }
             .reject { |value| value.respond_to?(:blank?) ? value.blank? : value.nil? }
             .uniq.join(" ")
    end

    def merge_currency_data(existing_data, currency)
      normalize_data_attributes(existing_data).merge("currency" => currency)
    end

    def loan_param(field_name)
      "loan[#{field_name}]"
    end
end
