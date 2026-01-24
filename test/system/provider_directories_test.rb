require "application_system_test_case"

class ProviderDirectoriesTest < ApplicationSystemTestCase
  setup do
    sign_in users(:family_admin)
  end

  test "can create, edit, and archive providers" do
    visit settings_provider_directories_path

    click_on "New provider"

    within "turbo-frame#modal" do
      fill_in "Provider name", with: "Galeri24"
      select "Bullion Dealer", from: "Provider type"
      click_button "Create provider"
    end

    assert_text "Galeri24"

    within("tr", text: "Galeri24") do
      find("button[data-DS--menu-target='button']").click
      click_on "Edit"
    end

    within "turbo-frame#modal" do
      fill_in "Provider name", with: "Galeri24 Updated"
      click_button "Save provider"
    end

    assert_text "Galeri24 Updated"

    within("tr", text: "Galeri24 Updated") do
      find("button[data-DS--menu-target='button']").click
      click_on "Archive"
    end

    within "#confirm-dialog" do
      click_button "Archive provider"
    end

    assert_text "Archived providers"
    assert_text "Galeri24 Updated"
  end
end
