require "test_helper"

class BmtHsiTest < ActiveSupport::TestCase
  test "Depository supports cooperative subtype" do
    account = Depository.new(subtype: "cooperative")
    assert account.valid?, "Depository should be valid with 'cooperative' subtype"
    assert_equal "cooperative", account.subtype
  end

  test "Investment supports cooperative_share subtype" do
    account = Investment.new(subtype: "cooperative_share")
    assert account.valid?, "Investment should be valid with 'cooperative_share' subtype"
    assert_equal "cooperative_share", account.subtype
  end

  test "ProviderDirectory includes cooperative kind" do
    assert_includes ProviderDirectory::KINDS.keys, :cooperative, "ProviderDirectory types should include :cooperative key"
    assert_includes ProviderDirectory::KINDS.values, "cooperative", "ProviderDirectory types should include 'cooperative' value"
  end
end
