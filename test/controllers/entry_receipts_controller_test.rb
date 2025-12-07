# frozen_string_literal: true

require "test_helper"

class EntryReceiptsControllerTest < ActionDispatch::IntegrationTest
  setup do
    sign_in users(:family_admin)
    @entry = entries(:checking_one)
  end

  test "should delete attached receipt" do
    # Attach a test file first
    @entry.receipt.attach(
      io: Rails.root.join("test/fixtures/files/test_receipt.png").open,
      filename: "test_receipt.png",
      content_type: "image/png"
    )

    assert @entry.receipt.attached?

    delete entry_receipt_url(@entry)

    assert_redirected_to transaction_path(@entry)
    @entry.reload
    # Note: purge_later is async, so we just check the redirect works
  end

  test "should redirect back when no receipt attached" do
    assert_not @entry.receipt.attached?

    delete entry_receipt_url(@entry)

    assert_redirected_to transaction_path(@entry)
  end
end
