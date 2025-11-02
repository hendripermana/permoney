# frozen_string_literal: true

require "test_helper"

class BreadcrumbItemComponentTest < ViewComponent::TestCase
  test "renders link item" do
    render_inline(BreadcrumbItemComponent.new(text: "Home", href: "/"))

    assert_selector "a[href='/']", text: "Home"
  end

  test "renders current page item" do
    render_inline(BreadcrumbItemComponent.new(text: "Current", current: true))

    assert_selector "span[aria-current='page']", text: "Current"
    assert_no_selector "a"
  end

  test "renders item with icon" do
    render_inline(BreadcrumbItemComponent.new(text: "Home", href: "/", icon: "home"))

    assert_selector "a[href='/']"
    assert_selector "svg" # Lucide icon
    assert_text "Home"
  end

  test "renders plain text item without href" do
    render_inline(BreadcrumbItemComponent.new(text: "Plain Text"))

    assert_selector "span", text: "Plain Text"
    assert_no_selector "a"
    assert_no_selector "[aria-current]"
  end

  test "applies correct classes for link item" do
    render_inline(BreadcrumbItemComponent.new(text: "Link", href: "/test"))

    assert_selector "a.text-gray-500"
    assert_selector "a.hover\\:text-primary"
  end

  test "applies correct classes for current item" do
    render_inline(BreadcrumbItemComponent.new(text: "Current", current: true))

    assert_selector "span.text-primary"
  end

  test "link item has proper structure" do
    render_inline(BreadcrumbItemComponent.new(text: "Test", href: "/test", icon: "folder"))

    assert_selector "li[role='listitem']" do
      assert_selector "a[href='/test']" do
        assert_selector "svg" # Icon
        assert_selector "span", text: "Test" # Text
      end
    end
  end

  test "current item does not create link even with href" do
    render_inline(BreadcrumbItemComponent.new(text: "Current", href: "/current", current: true))

    assert_no_selector "a"
    assert_selector "span[aria-current='page']", text: "Current"
  end
end
