# frozen_string_literal: true

# Split Button Component
# Combines a primary action button with a dropdown menu for related secondary actions.
# This modern UI pattern reduces visual clutter while maintaining quick access to related actions.
#
# Best for: Primary actions with 2-3 related secondary actions that are used less frequently.
# Pattern inspired by shadcn/ui and modern design systems (2024-2025).
#
# This component follows Rails 8.1 best practices:
# - No inline Ruby logic in templates
# - Computed values in component class methods
# - Proper accessibility attributes
# - Design system token usage
#
# Usage:
#   <%= render DS::SplitButton.new(
#     primary_text: "New transaction",
#     primary_href: new_transaction_path,
#     primary_frame: :modal
#   ) do |split|
#     split.with_menu_item(text: "Lend More Money", href: new_global_lending_personal_lendings_path, icon: "plus", frame: :modal)
#     split.with_menu_item(text: "Record Payment Received", href: new_global_payment_personal_lendings_path, icon: "banknote", frame: :modal)
#   end %>
class DS::SplitButton < DesignSystemComponent
  attr_reader :primary_text, :primary_href, :primary_icon, :primary_variant, :primary_frame,
              :primary_opts, :menu_placement, :menu_offset, :class_name

  renders_many :menu_items, ->(variant: :link, **opts) do
    DS::MenuItem.new(variant: variant, **opts)
  end

  def initialize(
    primary_text:,
    primary_href:,
    primary_icon: "plus",
    primary_variant: :primary,
    primary_frame: :modal,
    menu_placement: "bottom-end",
    menu_offset: 12,
    html_class: nil,
    **primary_opts
  )
    @primary_text = primary_text
    @primary_href = primary_href
    @primary_icon = primary_icon
    @primary_variant = normalize_variant(primary_variant)
    @primary_frame = primary_frame
    @primary_opts = primary_opts
    @menu_placement = menu_placement
    @menu_offset = menu_offset
    @class_name = html_class

    validate_menu_items_requirement
  end

  def aria_label
    "#{primary_text} and related actions"
  end

  def primary_button_classes
    "rounded-r-none border-r-0"
  end

  def dropdown_trigger_classes
    "rounded-l-none px-2 -ml-px"
  end

  def dropdown_button_variant
    case @primary_variant
    when :primary
      :icon_inverse
    else
      :icon
    end
  end

  def dropdown_button_icon
    "chevron-down"
  end

  private
    def normalize_variant(variant)
      variant.to_sym
    end

    def validate_menu_items_requirement
      # Validation happens at render time - menu_items are optional
      # Component still works without menu items (just shows primary button)
    end
end
