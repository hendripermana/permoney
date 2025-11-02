# frozen_string_literal: true

# KPI Card Component for Financial Dashboard
# Based on 2025 best practices for data visualization
#
# Features:
# - Live metrics display with real data
# - Trend indicators (up/down/neutral)
# - Color-coded gradient backgrounds
# - Icon support for visual context
# - Responsive design (mobile + desktop)
# - Accessibility compliant (WCAG 2.2)
#
# Usage:
#   <%= render UI::KpiCard.new(
#     title: "Net Worth",
#     value: "$50,234",
#     change_percent: 12.5,
#     change_direction: :up,
#     icon: "trending-up",
#     color: "blue",
#     description: "Total assets minus liabilities",
#     cta_text: "View details",
#     cta_path: accounts_path
#   ) %>
#
class UI::KpiCard < ApplicationComponent
  COLORS = {
    blue: "bg-gradient-to-br from-blue-600 to-blue-700",
    emerald: "bg-gradient-to-br from-emerald-600 to-emerald-700",
    fuchsia: "bg-gradient-to-br from-fuchsia-700 to-fuchsia-800",
    amber: "bg-gradient-to-br from-amber-600 to-amber-700",
    rose: "bg-gradient-to-br from-rose-600 to-rose-700",
    slate: "bg-gradient-to-br from-slate-600 to-slate-700"
  }.freeze

  CHANGE_DIRECTIONS = {
    up: { icon: "trending-up", color: "text-white/90" },
    down: { icon: "trending-down", color: "text-white/90" },
    neutral: { icon: "minus", color: "text-white/70" }
  }.freeze

  attr_reader :title, :value, :previous_value, :change_percent, :change_direction, :icon,
              :color, :description, :cta_text, :cta_path, :period, :show_privacy_toggle

  # @param title [String] KPI title (e.g., "Net Worth")
  # @param value [String] Formatted value (e.g., "$50,234")
  # @param previous_value [String] Previous period value for context (e.g., "$44,600")
  # @param change_percent [Float] Percentage change (e.g., 12.5 for +12.5%)
  # @param change_direction [Symbol] Direction: :up, :down, :neutral
  # @param icon [String] Lucide icon name for context
  # @param color [String] Color theme: blue, emerald, fuchsia, amber, rose, slate
  # @param description [String] Short description of the metric
  # @param cta_text [String] Call-to-action text (e.g., "View details")
  # @param cta_path [String] Path for the CTA link
  # @param period [String] Time period context (e.g., "vs last month")
  # @param show_privacy_toggle [Boolean] Show eye icon to toggle value visibility (default: false)
  def initialize(
    title:,
    value:,
    previous_value: nil,
    change_percent: nil,
    change_direction: :neutral,
    icon: nil,
    color: :blue,
    description: nil,
    cta_text: "View details",
    cta_path: "#",
    period: "vs last month",
    show_privacy_toggle: false
  )
    @title = title
    @value = value
    @previous_value = previous_value
    @change_percent = change_percent
    @change_direction = change_direction
    @icon = icon
    @color = color
    @description = description
    @cta_text = cta_text
    @cta_path = cta_path
    @period = period
    @show_privacy_toggle = show_privacy_toggle
  end

  # Background gradient based on color theme
  def card_classes
    base = "rounded-2xl overflow-hidden shadow-lg border-0 transition-transform duration-300 hover:scale-[1.02]"
    gradient = COLORS[@color.to_sym] || COLORS[:blue]
    "#{base} #{gradient}"
  end

  # Format change percentage with proper sign
  def formatted_change
    return nil unless @change_percent

    sign = @change_percent >= 0 ? "+" : ""
    "#{sign}#{@change_percent.round(1)}%"
  end

  # Get trend icon and color
  def trend_indicator
    CHANGE_DIRECTIONS[@change_direction.to_sym] || CHANGE_DIRECTIONS[:neutral]
  end

  # Whether to show the change indicator
  def show_change?
    @change_percent.present?
  end

  # Accessibility label for the card
  def aria_label
    label = "#{@title}: #{@value}"
    label += ", #{formatted_change} #{@period}" if show_change?
    label
  end

  # Privacy toggle enabled?
  def privacy_toggle_enabled?
    @show_privacy_toggle
  end

  # Storage key for privacy preference
  def privacy_storage_key
    "kpi_card_privacy_#{@title.parameterize.underscore}"
  end

  # Badge classes for change indicator (2025 modern style)
  def change_badge_classes
    base = "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors"

    case @change_direction
    when :up
      "#{base} bg-emerald-50 text-emerald-700 ring-emerald-600/20 theme-dark:bg-emerald-500/10 theme-dark:text-emerald-400 theme-dark:ring-emerald-400/30"
    when :down
      "#{base} bg-rose-50 text-rose-700 ring-rose-600/20 theme-dark:bg-rose-500/10 theme-dark:text-rose-400 theme-dark:ring-rose-400/30"
    else
      "#{base} bg-gray-50 text-gray-700 ring-gray-600/20 theme-dark:bg-gray-500/10 theme-dark:text-gray-400 theme-dark:ring-gray-400/30"
    end
  end

  # Whether to show previous value
  def show_previous_value?
    @previous_value.present? && @previous_value != @value
  end
end
