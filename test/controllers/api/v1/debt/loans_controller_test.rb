require "test_helper"

class Api::V1::Debt::LoansControllerTest < ActionDispatch::IntegrationTest
  setup do
    sign_in users(:family_admin)
    @loan = accounts(:loan)
    @api_key = api_keys(:active_key)
    @api_key.update!(source: "web") if @api_key.source.blank?
    @api_headers = {
      "X-Api-Key" => @api_key.display_key,
      "ACCEPT" => "application/json"
    }
  end

  test "preview returns schedule rows" do
    post "/api/v1/debt/loans/plan/preview", params: {
      account_id: @loan.id,
      principal_amount: 1_000_000,
      rate_or_profit: 0.1,
      tenor_months: 12
    }, headers: @api_headers, as: :json
    assert_response :success
    body = JSON.parse(@response.body)
    assert_equal 12, body["count"]
    assert body["totals"].present?
    assert_nil body["rounding_note"], body["rounding_note"]
  end

  test "regenerate replaces only future rows and returns payload" do
    # Seed posted and planned
    LoanInstallment.create!(account_id: @loan.id, installment_no: 1, due_date: Date.current - 1, status: "posted", principal_amount: 100, interest_amount: 10, total_amount: 110)
    LoanInstallment.create!(account_id: @loan.id, installment_no: 2, due_date: Date.current + 1, status: "planned", principal_amount: 100, interest_amount: 10, total_amount: 110)

    post "/api/v1/debt/loans/plan/regenerate", params: {
      account_id: @loan.id,
      principal_amount: 1_000_000,
      rate_or_profit: 0.1,
      tenor_months: 6
    }, headers: @api_headers, as: :json
    assert_response :success
    body = JSON.parse(@response.body)
    assert body["regenerated_count"].to_i > 0
    assert body["next_due_date"].present?
  end

  test "preview with invalid balloon returns 422" do
    post "/api/v1/debt/loans/plan/preview", params: {
      account_id: @loan.id,
      principal_amount: 1_000,
      rate_or_profit: 0.1,
      tenor_months: 12,
      balloon_amount: 2000
    }, headers: @api_headers, as: :json
    assert_response :unprocessable_entity
  end

  test "preview with invalid day_count returns 422" do
    post "/api/v1/debt/loans/plan/preview", params: {
      account_id: @loan.id,
      principal_amount: 1_000,
      rate_or_profit: 0.1,
      tenor_months: 12,
      day_count: "30/360" # invalid token
    }, headers: @api_headers, as: :json
    assert_response :unprocessable_entity
  end
end
