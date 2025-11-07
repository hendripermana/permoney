# frozen_string_literal: true

require "test_helper"

class UI::KpiCardComponentTest < ViewComponent::TestCase
  test "renders basic KPI card with all elements" do
    render_inline(UI::KpiCard.new(
      title: "Net Worth",
      value: "$50,234",
      change_percent: 12.5,
      change_direction: :up,
      icon: "trending-up",
      color: :blue,
      description: "Total assets minus liabilities",
      cta_text: "View details",
      cta_path: "/accounts"
    ))

    assert_selector "div[role='article']"
    assert_text "Net Worth"
    assert_text "$50,234"
    assert_text "+12.5%"
    assert_text "Total assets minus liabilities"
    assert_text "View details"
    assert_selector "a[href='/accounts']"
  end

  test "renders KPI card without change indicator" do
    render_inline(UI::KpiCard.new(
      title: "Test Metric",
      value: "$1,000",
      change_percent: nil,
      icon: "dollar-sign",
      color: :emerald
    ))

    assert_text "Test Metric"
    assert_text "$1,000"
    assert_no_text "vs last month"
    assert_no_selector "svg[class*='trending']"
  end

  test "renders KPI card with down trend" do
    render_inline(UI::KpiCard.new(
      title: "Expenses",
      value: "$3,500",
      change_percent: -5.2,
      change_direction: :down,
      icon: "arrow-down",
      color: :rose
    ))

    assert_text "Expenses"
    assert_text "$3,500"
    assert_text "-5.2%"
  end

  test "renders KPI card with neutral trend" do
    render_inline(UI::KpiCard.new(
      title: "Stable Metric",
      value: "$2,000",
      change_percent: 0.3,
      change_direction: :neutral,
      icon: "minus",
      color: :slate
    ))

    assert_text "Stable Metric"
    assert_text "$2,000"
    assert_text "+0.3%"
  end

  test "applies correct gradient class for each color" do
    UI::KpiCard::COLORS.each_key do |color|
      render_inline(UI::KpiCard.new(
        title: "Test",
        value: "$100",
        color: color
      ))

      # Check that gradient class is applied
      assert_selector "div[class*='bg-gradient']"
    end
  end

  test "renders with proper aria label" do
    render_inline(UI::KpiCard.new(
      title: "Income",
      value: "$5,000",
      change_percent: 8.5,
      change_direction: :up
    ))

    assert_selector "div[aria-label*='Income: $5,000']"
    assert_selector "div[aria-label*='+8.5%']"
  end

  test "renders icon when provided" do
    render_inline(UI::KpiCard.new(
      title: "Test",
      value: "$100",
      icon: "wallet"
    ))

    assert_selector "svg"
  end

  test "does not render icon when not provided" do
    render_inline(UI::KpiCard.new(
      title: "Test",
      value: "$100",
      icon: nil,
      show_privacy_toggle: false
    ))

    # When no icon and privacy toggle disabled, icon section should be completely absent
    assert_no_selector ".px-6.pt-6.pb-3\\.5"

    # But there might be other icons (like in change indicator)
    # So check specifically that no privacy toggle icons exist
    assert_no_selector "[data-kpi-card-target='showIcon']"
    assert_no_selector "[data-kpi-card-target='hideIcon']"
  end

  test "renders CTA link with proper turbo frame" do
    render_inline(UI::KpiCard.new(
      title: "Test",
      value: "$100",
      cta_text: "View more",
      cta_path: "/test-path"
    ))

    assert_selector "a[href='/test-path']", text: "View more"
    assert_selector "a[data-turbo-frame='_top']"
  end

  test "has hover transform animation class" do
    render_inline(UI::KpiCard.new(
      title: "Test",
      value: "$100"
    ))

    assert_selector "div[class*='hover:scale']"
  end

  test "renders privacy toggle when enabled" do
    render_inline(UI::KpiCard.new(
      title: "Income",
      value: "$5,000",
      icon: "trending-up",
      show_privacy_toggle: true
    ))

    # Check privacy toggle button
    assert_selector "button[data-kpi-card-target='toggleButton']"
    assert_selector "button[data-action*='togglePrivacy']"

    # Check icons for privacy toggle
    assert_selector "svg[data-kpi-card-target='showIcon']"
    assert_selector "svg[data-kpi-card-target='hideIcon']"

    # Check storage key attribute
    assert_selector "div[data-kpi-card-storage-key-value='kpi_card_privacy_income']"

    # Check hidden value placeholder
    assert_selector "div[data-kpi-card-target='hiddenValue']"
    assert_text "••••••"
  end

  test "does not render privacy toggle when disabled" do
    render_inline(UI::KpiCard.new(
      title: "Income",
      value: "$5,000",
      icon: "trending-up",
      show_privacy_toggle: false
    ))

    # Should not have privacy toggle elements
    assert_no_selector "button[data-action*='togglePrivacy']"
    assert_no_selector "div[data-kpi-card-target='hiddenValue']"
    assert_no_selector "div[data-kpi-card-storage-key-value]"
  end
end
