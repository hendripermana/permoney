require "application_system_test_case"

class PreciousMetalsTest < ApplicationSystemTestCase
  setup do
    sign_in @user = users(:family_admin)

    Family.any_instance.stubs(:get_link_token).returns("test-link-token")

    visit root_url
    open_new_account_modal
  end

  test "can create gold account and add a buy transaction" do
    click_link "Precious Metal"

    fill_in "Account name*", with: "Gold Stash"
    fill_in "Quantity", with: "12.345"
    fill_in "Manual price per gram", with: "75.5"

    click_button "Create Account"

    assert_text "Gold Stash"
    click_on "Overview"
    assert_text "12.345 g"
    assert_text "Manual"

    within "[data-testid='activity-menu']" do
      click_on "New"
      click_on "New transaction"
    end

    select "Buy", from: "Type"
    fill_in "Quantity (grams)", with: "1.000"
    fill_in "Cash amount (optional)", with: "100"
    fill_in "Date", with: Date.current
    click_button "Add transaction"

    assert_text "Buy Gold"
    assert_text "1.000 g"
  end

  test "adding a provider keeps form values" do
    click_link "Precious Metal"

    fill_in "Account name*", with: "Gold Reserve"
    fill_in "Quantity", with: "2.000"

    find("summary", text: "Additional details").click
    click_on "Add new provider"

    within "turbo-frame#modal" do
      fill_in "Provider name", with: "Gold Dealer"
      click_button "Create provider"
    end

    assert_field "Account name*", with: "Gold Reserve"
    assert_field "Quantity", with: "2.000"
  end

  private

    def open_new_account_modal
      within "[data-controller='DS--tabs']" do
        click_button "All"
        click_link "New account"
      end
    end
end
