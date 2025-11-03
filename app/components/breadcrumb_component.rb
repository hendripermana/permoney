# frozen_string_literal: true

# Breadcrumb navigation component for hierarchical page structure
#
# Features:
# - Icon support for each item (optional)
# - Semantic HTML with proper ARIA attributes
# - Accessible navigation with screen reader support
# - Design system integration
# - Flexible item types (link, text, current page)
#
# Usage:
#   <%= render BreadcrumbComponent.new do |breadcrumb| %>
#     <%= breadcrumb.with_item(text: "Home", href: root_path, icon: "home") %>
#     <%= breadcrumb.with_item(text: "Components", href: components_path, icon: "folder") %>
#     <%= breadcrumb.with_item(text: "Breadcrumb", current: true, icon: "file-text") %>
#   <% end %>
#
# Or with items array (backward compatible):
#   <%= render BreadcrumbComponent.new(items: [
#     { text: "Home", href: "/", icon: "home" },
#     { text: "Components", href: "/components", icon: "folder" },
#     { text: "Breadcrumb", current: true, icon: "file-text" }
#   ]) %>
#
class BreadcrumbComponent < ApplicationComponent
  renders_many :items, BreadcrumbItemComponent

  attr_reader :aria_label, :separator_icon

  # @param items [Array<Hash>] Optional array of breadcrumb items
  # @param aria_label [String] Accessible label for navigation
  # @param separator_icon [String] Icon name for separator (default: "chevron-right")
  def initialize(items: [], aria_label: "Breadcrumb", separator_icon: "chevron-right")
    @items_data = items
    @aria_label = aria_label
    @separator_icon = separator_icon
  end

  def before_render
    # Build items from array if provided (for backward compatibility)
    @items_data.each do |item_data|
      with_item(**item_data.symbolize_keys)
    end if @items_data.any?
  end

  def render?
    items.any?
  end

  # Container classes using design system tokens
  def container_classes
    "flex items-center gap-2 flex-wrap py-2"
  end
end
