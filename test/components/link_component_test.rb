# frozen_string_literal: true

require "test_helper"

class LinkComponentTest < ViewComponent::TestCase
  test "adds turbo method when method option is provided" do
    render_inline(
      DS::Link.new(
        text: "Cleanup",
        href: "/recurring_transactions/cleanup",
        method: :post
      )
    )

    assert_selector "a[data-turbo-method='post'][href='/recurring_transactions/cleanup']"
    assert_selector "a[rel~='nofollow']"
  end

  test "renders regular link without method" do
    render_inline(DS::Link.new(text: "Dashboard", href: "/"))

    assert_selector "a[href='/']", text: "Dashboard"
    assert_no_selector "a[data-turbo-method]"
  end
end
