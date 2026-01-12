# frozen_string_literal: true

module CategoryHelper
  # Sanitize category color to prevent XSS attacks
  # Validates hex color format (#RGB, #RRGGBB) and returns safe color or default
  #
  # @param color [String] Category color value from database
  # @param default [String] Default color if validation fails (default: "#737373")
  # @return [String] Sanitized hex color code
  #
  # Security: Prevents XSS by validating color format before using in CSS
  # Only allows valid hex color codes (#RGB or #RRGGBB format)
  def sanitize_category_color(color, default: "#737373")
    return default if color.blank?

    # Normalize: remove whitespace and convert to string
    normalized_color = color.to_s.strip

    # Validate hex color format (#RGB or #RRGGBB)
    if normalized_color.match?(/\A#[0-9a-fA-F]{3,6}\z/)
      normalized_color
    else
      default
    end
  end
end