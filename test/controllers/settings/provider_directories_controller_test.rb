require "test_helper"

class Settings::ProviderDirectoriesControllerTest < ActionDispatch::IntegrationTest
  setup do
    sign_in users(:family_admin)
  end

  test "shows providers index" do
    get settings_provider_directories_url

    assert_response :success
    assert_select "h1", text: "Providers"
  end

  test "renders new provider form inside a turbo frame" do
    get new_settings_provider_directory_url, headers: { "Turbo-Frame" => "modal" }

    assert_response :success
    assert_select "form[action='#{settings_provider_directories_path}']"
  end

  test "creates provider" do
    assert_difference "ProviderDirectory.count", 1 do
      post settings_provider_directories_url, params: {
        provider_directory: {
          name: "Galeri24",
          kind: "bullion_dealer",
          country: "ID",
          website: "https://galeri24.co.id",
          notes: "Main dealer"
        }
      }
    end

    assert_redirected_to settings_provider_directories_url
  end

  test "turbo stream create honors return_to" do
    post settings_provider_directories_url(format: :turbo_stream), params: {
      provider_directory: { name: "Turbo Provider" },
      return_to: accounts_path
    }

    assert_response :success
    assert_includes @response.body, "turbo-stream"
    assert_includes @response.body, accounts_path
  end

  test "updates provider" do
    provider = provider_directories(:pegadaian)

    patch settings_provider_directory_url(provider), params: {
      provider_directory: { name: "Pegadaian Updated" }
    }

    assert_redirected_to settings_provider_directories_url
    assert_equal "Pegadaian Updated", provider.reload.name
  end

  test "rejects unsafe return_to values" do
    unsafe_paths = [
      "https://evil.com",
      "//evil.com",
      "/accounts\r\nSet-Cookie:evil=1",
      "/accounts%0d%0aSet-Cookie:evil=1"
    ]

    unsafe_paths.each do |unsafe|
      assert_difference "ProviderDirectory.count", 1 do
        post settings_provider_directories_url, params: {
          provider_directory: { name: "Unsafe #{SecureRandom.hex(4)}" },
          return_to: unsafe
        }
      end

      assert_redirected_to settings_provider_directories_url
    end
  end

  test "accepts valid return_to path" do
    post settings_provider_directories_url, params: {
      provider_directory: { name: "Internal Path" },
      return_to: accounts_path
    }

    assert_redirected_to accounts_url
  end

  test "archives provider" do
    provider = provider_directories(:pegadaian)

    delete settings_provider_directory_url(provider)

    assert_redirected_to settings_provider_directories_url
    assert provider.reload.archived_at.present?
  end

  test "restores provider" do
    provider = provider_directories(:archived_provider)

    patch restore_settings_provider_directory_url(provider)

    assert_redirected_to settings_provider_directories_url
    assert_nil provider.reload.archived_at
  end

  test "turbo stream index returns combobox options" do
    get settings_provider_directories_url(format: :turbo_stream, q: "peg")

    assert_response :success
    assert_includes @response.body, provider_directories(:pegadaian).name
  end

  test "turbo stream index excludes archived providers by default" do
    get settings_provider_directories_url(format: :turbo_stream, q: "old")

    assert_response :success
    refute_includes @response.body, provider_directories(:archived_provider).name
  end
end
