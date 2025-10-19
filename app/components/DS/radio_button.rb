# frozen_string_literal: true

class DS::RadioButton < DesignSystemComponent
  attr_reader :name, :value, :label, :checked, :disabled, :required, :form, :id

  def initialize(name:, value: nil, label: nil, checked: false, disabled: false, required: false, form: nil, **opts)
    @name = name
    @value = value
    @label = label
    @checked = checked
    @disabled = disabled
    @required = required
    @form = form
    @id = opts.delete(:id) || "radio-#{name}-#{value}".parameterize
    @opts = opts
  end

  def call
    content_tag(:div, class: container_classes) do
      safe_join([
        radio_input,
        label_element
      ].compact)
    end
  end

  private

    def radio_input
      opts = @opts.dup
      data = opts.delete(:data) || {}

      input_classes = "sr-only"
      input_opts = {
        type: "radio",
        name: name,
        value: value,
        id: id,
        checked: checked,
        disabled: disabled,
        class: input_classes,
        data: data
      }.merge(opts)

      content_tag(:input, nil, input_opts)
    end

    def label_element
      return unless label

      label_classes = "flex items-center gap-2 cursor-pointer"
      label_classes += " opacity-50 cursor-not-allowed" if disabled

      content_tag(:label, for: id, class: label_classes) do
        safe_join([
          content_tag(:span, class: indicator_classes) do
            content_tag(:span, nil, class: inner_indicator_classes) if checked
          end,
          content_tag(:span, label, class: "text-sm font-medium text-primary")
        ])
      end
    end

    def container_classes
      "flex items-center gap-2"
    end

    def indicator_classes
      base_classes = "w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors"
      base_classes += if checked
        " border-primary bg-primary"
      else
        " border-secondary hover:border-primary"
      end
      base_classes
    end

    def inner_indicator_classes
      "w-2 h-2 bg-inverse rounded-full"
    end
end
