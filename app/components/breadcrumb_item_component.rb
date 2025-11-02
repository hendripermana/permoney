# frozen_string_literal: true

# Individual breadcrumb item component
#
# Represents a single item in the breadcrumb navigation trail.
# Automatically determines if it's a link or text based on href presence.
#
# Usage:
#   <%= breadcrumb.with_item(text: "Home", href: "/", icon: "home") %>
#   <%= breadcrumb.with_item(text: "Current Page", current: true) %>
#
class BreadcrumbItemComponent < ApplicationComponent
  attr_reader :text, :href, :icon, :current

  # @param text [String] The display text for the breadcrumb item
  # @param href [String] Optional URL for link items
  # @param icon [String] Optional Lucide icon name
  # @param current [Boolean] Whether this is the current page (default: false)
  def initialize(text:, href: nil, icon: nil, current: false)
    @text = text
    @href = href
    @icon = icon
    @current = current
  end

  # Determine if this item should be rendered as a link
  def link?
    href.present? && !current
  end

  # Container classes for the list item
  def container_classes
    "flex items-center gap-1.5"
  end

  # Text classes based on item state
  # Includes flex layout for horizontal icon + text alignment (Tailwind v4 best practice)
  def text_classes
    # Base: flex container with vertical centering and gap between icon and text
    base_classes = "flex items-center gap-1.5 text-sm font-medium"

    if current
      # Current page - use primary color
      "#{base_classes} text-primary"
    elsif link?
      # Link - use subdued color with hover
      "#{base_classes} text-gray-500 theme-dark:text-gray-400 hover:text-primary theme-dark:hover:text-primary transition-colors"
    else
      # Plain text - use subdued color
      "#{base_classes} text-gray-500 theme-dark:text-gray-400"
    end
  end

  # Icon color based on item state
  def icon_color
    if current
      "default"
    else
      "default"
    end
  end

  # ARIA attributes for current page
  def aria_current
    "page" if current
  end
end
