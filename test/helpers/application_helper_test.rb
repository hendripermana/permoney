require "test_helper"

class ApplicationHelperTest < ActionView::TestCase
  include ApplicationHelper

  test "markdown sanitizes scripts and preserves code and tables" do
    input = <<~MD
      # Heading

      <script>alert('xss')</script>

      ```ruby
      puts 'hello'
      ```

      | Col1 | Col2 |
      | ---- | ---- |
      | A    | B    |

      [link](https://example.com)
    MD

    html = markdown(input)

    assert_includes html, "<h1>Heading</h1>"
    assert_includes html, "<code>"
    assert_includes html, "<table>"
    assert_includes html, "<a href=\"https://example.com\""
    refute_includes html, "<script>"
  end
end

