require "test_helper"

class ProviderDirectoryTest < ActiveSupport::TestCase
  test "requires a name" do
    provider = ProviderDirectory.new(user: users(:family_admin), name: "")

    refute provider.valid?
    assert_includes provider.errors[:name], "can't be blank"
  end

  test "enforces case-insensitive uniqueness per user" do
    provider = ProviderDirectory.new(user: users(:family_admin), name: "PEGADAIAN")

    refute provider.valid?
    assert_includes provider.errors[:name], "has already been taken"
  end

  test "trims names before validation" do
    provider = ProviderDirectory.new(user: users(:family_admin), name: " BSI ")

    refute provider.valid?
    assert_equal "BSI", provider.name
    assert_includes provider.errors[:name], "has already been taken"
  end

  test "archives and restores providers" do
    provider = provider_directories(:pegadaian)

    assert_nil provider.archived_at
    provider.archive!
    assert provider.archived_at.present?

    provider.restore!
    assert_nil provider.archived_at
  end

  test "rejects unsafe website URLs" do
    provider = ProviderDirectory.new(
      user: users(:family_admin),
      name: "Bad Link",
      website: "javascript:alert(1)"
    )

    refute provider.valid?
    assert_includes provider.errors[:website], "must be a valid http or https URL"
  end

  test "rejects website URLs with newlines" do
    provider = ProviderDirectory.new(
      user: users(:family_admin),
      name: "Newline Link",
      website: "https://example.com\n.evil.com"
    )

    refute provider.valid?
    assert_includes provider.errors[:website], "must be a valid http or https URL"
  end
end
