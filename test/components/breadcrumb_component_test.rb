# frozen_string_literal: true

require "test_helper"

class BreadcrumbComponentTest < ViewComponent::TestCase
  test "renders breadcrumb with items from array" do
    items = [
      { text: "Home", href: "/", icon: "home" },
      { text: "Components", href: "/components", icon: "folder" },
      { text: "Breadcrumb", current: true, icon: "file-text" }
    ]

    render_inline(BreadcrumbComponent.new(items: items))

    assert_selector "nav[aria-label='Breadcrumb']"
    assert_selector "ol[role='list']"
    assert_selector "li[role='listitem']", count: 3
    assert_text "Home"
    assert_text "Components"
    assert_text "Breadcrumb"
  end

  test "renders breadcrumb with block syntax" do
    render_inline(BreadcrumbComponent.new) do |breadcrumb|
      breadcrumb.with_item(text: "Home", href: "/", icon: "home")
      breadcrumb.with_item(text: "Breadcrumb", current: true)
    end

    assert_selector "nav[aria-label='Breadcrumb']"
    assert_selector "li[role='listitem']", count: 2
    assert_text "Home"
    assert_text "Breadcrumb"
  end

  test "renders separators between items" do
    items = [
      { text: "Home", href: "/" },
      { text: "Page", href: "/page" },
      { text: "Current", current: true }
    ]

    render_inline(BreadcrumbComponent.new(items: items))

    # Should have 2 separators for 3 items
    assert_selector "li[role='presentation'][aria-hidden='true']", count: 2
  end

  test "renders links for non-current items" do
    items = [
      { text: "Home", href: "/" },
      { text: "Current", current: true }
    ]

    render_inline(BreadcrumbComponent.new(items: items))

    assert_selector "a[href='/']", text: "Home"
    assert_selector "span[aria-current='page']", text: "Current"
  end

  test "renders icons when provided" do
    items = [
      { text: "Home", href: "/", icon: "home" },
      { text: "Current", current: true, icon: "file-text" }
    ]

    render_inline(BreadcrumbComponent.new(items: items))

    # Icons should be rendered via icon helper (Lucide icons)
    # 2 items with icons + 1 separator = 3 SVG icons total
    assert_selector "svg", minimum: 3
  end

  test "does not render when no items provided" do
    render_inline(BreadcrumbComponent.new(items: []))

    assert_no_selector "nav"
  end

  test "accepts custom aria label" do
    items = [{ text: "Home", href: "/" }]

    render_inline(BreadcrumbComponent.new(items: items, aria_label: "Custom Navigation"))

    assert_selector "nav[aria-label='Custom Navigation']"
  end

  test "accepts custom separator icon" do
    items = [
      { text: "Home", href: "/" },
      { text: "Current", current: true }
    ]

    render_inline(BreadcrumbComponent.new(items: items, separator_icon: "arrow-right"))

    # Separator should be present
    assert_selector "li[role='presentation']"
  end

  test "backward compatibility with array format" do
    # Old format: [name, path]
    items = [
      ["Home", "/"],
      ["Components", "/components"],
      ["Breadcrumb", nil]
    ]

    # This would be converted in the partial, but we test direct component usage
    normalized = items.map.with_index do |item, index|
      {
        text: item[0],
        href: item[1],
        current: (index == items.size - 1)
      }
    end

    render_inline(BreadcrumbComponent.new(items: normalized))

    assert_selector "nav"
    assert_text "Home"
    assert_text "Components"
    assert_text "Breadcrumb"
  end
end
