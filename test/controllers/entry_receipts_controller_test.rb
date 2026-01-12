# frozen_string_literal: true

require "test_helper"

class EntryReceiptsControllerTest < ActionDispatch::IntegrationTest
  setup do
    sign_in users(:family_admin)
    @entry = entries(:transaction)
  end

  test "should delete attached receipt and enqueue purge job" do
    # Attach a test file first
    @entry.receipt.attach(
      io: StringIO.new("fake image content"),
      filename: "test_receipt.png",
      content_type: "image/png"
    )

    assert @entry.receipt.attached?

    # Verify purge job is enqueued
    assert_enqueued_with(job: ActiveStorage::PurgeJob) do
      delete entry_receipt_url(@entry)
    end

    assert_redirected_to transactions_path
  end

  test "should redirect back when no receipt attached" do
    assert_not @entry.receipt.attached?

    delete entry_receipt_url(@entry)

    assert_redirected_to transactions_path
  end
end
