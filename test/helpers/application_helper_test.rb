require "test_helper"

class ApplicationHelperTest < ActionView::TestCase
  test "time_based_greeting returns good morning for morning hours" do
    Time.stub :current, Time.new(2024, 1, 1, 8, 0, 0) do
      assert_equal "Good morning", time_based_greeting
    end
  end

  test "time_based_greeting returns good afternoon for afternoon hours" do
    Time.stub :current, Time.new(2024, 1, 1, 14, 0, 0) do
      assert_equal "Good afternoon", time_based_greeting
    end
  end

  test "time_based_greeting returns good evening for evening hours" do
    Time.stub :current, Time.new(2024, 1, 1, 20, 0, 0) do
      assert_equal "Good evening", time_based_greeting
    end
  end

  test "time_based_greeting returns good evening for late night hours" do
    Time.stub :current, Time.new(2024, 1, 1, 2, 0, 0) do
      assert_equal "Good evening", time_based_greeting
    end
  end
end
