# frozen_string_literal: true

# DS Component Helper
# Provides common functionality for DS components
module DS::ComponentHelper
  extend ActiveSupport::Concern

  included do
    # Include common Rails helpers
    delegate :icon, :class_names, to: :helpers
  end

  private

  def helpers
    @helpers ||= begin
      controller = ApplicationController.new
      controller.request = ActionDispatch::TestRequest.create
      controller.helpers
    end
  end

  # Helper methods for DS components

  def render_field(field_name, config, &block)
    return unless config

    content_tag(:div, class: field_classes(field_name, config)) do
      safe_join([
        render_label(field_name, config),
        render_input(field_name, config, &block),
        render_errors(field_name, config),
        render_help_text(field_name, config)
      ].compact)
    end
  end

  def render_label(field_name, config)
    return unless config[:label]

    label_classes = "block text-sm font-medium text-primary mb-1"
    label_classes += " text-destructive" if config[:errors]&.any?

    content_tag(:label, config[:label], class: label_classes)
  end

  def render_input(field_name, config, &block)
    input_classes = "w-full px-3 py-2 border border-secondary rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"

    # Add validation classes
    if config[:errors]&.any?
      input_classes += " border-destructive focus:ring-destructive/20 focus:border-destructive"
    end

    # Add custom classes
    if config[:class]
      input_classes += " #{config[:class]}"
    end

    # Handle different input types
    case config[:type]
    when :text
      text_field_tag(field_name, config[:value], class: input_classes, **config.except(:label, :value, :type, :errors, :help_text))
    when :textarea
      text_area_tag(field_name, config[:value], class: input_classes, **config.except(:label, :value, :type, :errors, :help_text))
    when :select
      select_tag(field_name, options_for_select(config[:options] || [], config[:value]), class: input_classes, **config.except(:label, :value, :type, :options, :errors, :help_text))
    when :number
      number_field_tag(field_name, config[:value], class: input_classes, **config.except(:label, :value, :type, :errors, :help_text))
    when :date
      date_field_tag(field_name, config[:value], class: input_classes, **config.except(:label, :value, :type, :errors, :help_text))
    when :money
      number_field_tag(field_name, config[:value], class: input_classes, step: 0.01, min: 0, data: { currency: currency_symbol })
    else
      text_field_tag(field_name, config[:value], class: input_classes, **config.except(:label, :value, :type, :errors, :help_text))
    end
  end

  def render_errors(field_name, config)
    return unless config[:errors]&.any?

    content_tag(:div, class: "mt-1 text-sm text-destructive") do
      config[:errors].map do |error|
        content_tag(:div, error)
      end.join.html_safe
    end
  end

  def render_help_text(field_name, config)
    return unless config[:help_text]

    content_tag(:div, config[:help_text], class: "mt-1 text-xs text-secondary")
  end

  def field_classes(field_name, config)
    classes = "loan-field loan-field--#{field_name} mb-4"

    if config[:required]
      classes += " loan-field--required"
    end

    if config[:errors]&.any?
      classes += " loan-field--error"
    end

    classes
  end

  # Section wrapper helpers
  def section_wrapper(title: nil, subtitle: nil, &block)
    content_tag(:section, class: "space-y-3") do
      elements = []
      elements << content_tag(:h3, title, class: "text-primary font-medium") if title
      elements << content_tag(:p, subtitle, class: "text-xs text-secondary") if subtitle
      elements << capture(&block) if block
      safe_join(elements.compact)
    end
  end

  def grid_wrapper(&block)
    content_tag(:div, class: "grid gap-2 md:grid-cols-2", &block)
  end

  def visibility_wrapper(condition, &block)
    classes = "space-y-3"
    classes += " hidden" unless condition

    content_tag(:div, class: classes, &block)
  end

  def toggle_wrapper(title:, description:, &block)
    content_tag(:div, class: toggle_wrapper_classes) do
      elements = []
      elements << content_tag(:div) do
        safe_join([
          content_tag(:p, title, class: "text-sm font-medium text-primary"),
          content_tag(:p, description, class: "text-xs text-secondary")
        ])
      end
      elements << capture(&block) if block
      safe_join(elements.compact)
    end
  end

  def details_wrapper(title:, &block)
    content_tag(:details, class: "space-y-3") do
      elements = []
      elements << content_tag(:summary, title, class: "cursor-pointer text-primary font-medium")
      elements << content_tag(:div, class: "mt-2 space-y-3", &block) if block
      safe_join(elements.compact)
    end
  end

  # CSS class helpers
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

  # Data attribute helpers
  def visibility_data(mode)
    {
      "data-loan-form-target": "visibility",
      "data-loan-form-visibility-value": mode.to_s
    }
  end

  def overlay_data
    { "data-loan-form-target": "previewOverlay" }
  end

  def panel_data
    { "data-loan-form-target": "previewPanel" }
  end

  def preview_button_data
    {
      "data-loan-form-target": "previewLink",
      action: "click->loan-form#preparePreview"
    }
  end

  # Conditional helpers
  def conditional_fields(condition, content)
    content if condition
  end

  def help_text(text, **options)
    content_tag(:p, text, class: "text-xs text-secondary", **options)
  end

  def overlay_backdrop
    content_tag(:div, nil,
                class: "absolute inset-0 bg-black/40",
                data: { action: "click->loan-form#closePreview" })
  end

  def close_button
    content_tag(:button, icon("x", size: "sm"),
                type: "button",
                class: "text-sm text-secondary hover:text-primary",
                data: { action: "loan-form#closePreview" })
  end

  # Layout helpers
  def mode_active?(mode, current_mode)
    case mode
    when :personal
      current_mode == "personal"
    when :institution
      current_mode == "institution"
    else
      true
    end
  end

  # Helper methods for form rendering
  def text_field(field_name, config)
    return "" unless config

    value = config[:value] || ""
    classes = field_classes(field_name, config)
    attributes = config.except(:label, :value, :type, :errors, :help_text)

    "<input type=\"text\" name=\"#{field_name}\" value=\"#{value}\" class=\"#{classes}\" #{attributes.map { |k, v| "#{k}=\"#{v}\"" }.join(' ')}>"
  end

  def currency_symbol
    Current.family&.currency || "USD"
  rescue
    "USD"
  end

  def currency
    currency_symbol
  end

  def collection_select(field_name, collection, value_method, text_method, options = {}, html_options = {})
    "<select name=\"#{field_name}\" #{html_options.map { |k, v| "#{k}=\"#{v}\"" }.join(' ')}>" +
      collection.map do |item|
        value = item.send(value_method)
        text = item.send(text_method)
        selected = value == options[:selected] ? "selected" : ""
        "<option value=\"#{value}\" #{selected}>#{text}</option>"
      end.join +
      "</select>"
  end

  def turbo_frame_tag(name, **options, &block)
    content = block ? block.call : ""
    "<turbo-frame id=\"#{name}\" #{options.map { |k, v| "#{k}=\"#{v}\"" }.join(' ')}>#{content}</turbo-frame>"
  end
end
