require "test_helper"

class ServiceTest < ActiveSupport::TestCase
  setup do
    @service = services(:netflix)
  end

  test "valid service" do
    assert @service.valid?
  end

  test "requires name" do
    @service.name = nil
    assert_not @service.valid?
    assert_includes @service.errors[:name], "can't be blank"
  end

  test "requires unique name" do
    duplicate_service = Service.new(
      name: @service.name,
      category: "streaming",
      billing_frequency: "monthly"
    )
    assert_not duplicate_service.valid?
    assert_includes duplicate_service.errors[:name], "has already been taken"
  end

  test "requires category" do
    @service.category = nil
    assert_not @service.valid?
    assert_includes @service.errors[:category], "can't be blank"
  end

  test "category icon returns correct icon for streaming" do
    assert_equal "📺", @service.category_icon
  end

  test "category icon returns correct icon for software" do
    @service = services(:adobe)
    assert_equal "💻", @service.category_icon
  end

  test "monthly equivalent cost for annual billing" do
    @service.billing_frequency = "annual"
    @service.avg_monthly_cost = 120.0
    assert_equal 10.0, @service.monthly_equivalent_cost
  end

  test "formatted avg cost with value" do
    assert_equal "$15.99", @service.formatted_avg_cost
  end

  test "scope popular returns only popular services" do
    assert_includes Service.popular, @service
  end

  test "scope by category filters correctly" do
    streaming_services = Service.by_category("streaming")
    assert_includes streaming_services, @service
  end
end
