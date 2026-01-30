require "test_helper"

class ReportsControllerBreakdownTest < ActionDispatch::IntegrationTest
  setup do
    @family = families(:dylan_family)
    @user = users(:family_admin)
    sign_in @user

    # Setup Categories: Parent -> Child
    @parent_cat = Category.create!(name: "Parent Cat", color: "#000", family: @family, classification: "expense")
    @child_cat = Category.create!(name: "Child Cat", color: "#000", family: @family, parent: @parent_cat, classification: "expense")
    @independent_cat = Category.create!(name: "Independent Cat", color: "#000", family: @family, classification: "expense")

    # Create Transactions
    # 1. Transaction in Parent
    t1 = Transaction.new(category: @parent_cat)
    Entry.create!(
      date: Date.current,
      amount: 100,
      currency: "USD",
      name: "Parent Expense",
      account: accounts(:depository),
      entryable: t1
    )

    # 2. Transaction in Child
    t2 = Transaction.new(category: @child_cat)
    Entry.create!(
      date: Date.current,
      amount: 50,
      currency: "USD",
      name: "Child Expense",
      account: accounts(:depository),
      entryable: t2
    )

    # 3. Transaction in Independent
    t3 = Transaction.new(category: @independent_cat)
    Entry.create!(
      date: Date.current,
      amount: 75,
      currency: "USD",
      name: "Indep Expense",
      account: accounts(:depository),
      entryable: t3
    )
  end

  test "index renders transactions breakdown with nested structure" do
    get reports_path(period_type: :monthly)
    assert_response :success

    # Check for Parent Categories
    assert_select "td", text: /Parent Cat/
    assert_select "td", text: /Independent Cat/

    # Check for Subcategory (should be present and indented logic handled by view classes)
    assert_select "td", text: /Child Cat/

    # Check Totals calculations
    # Parent Total should be 100 (direct) + 50 (child) = 150
    # We look for the text "-$150.00" in the view
    assert_select "span", text: /-?\$150.00/
  end

  test "export_transactions generates CSV with subcategory column" do
    get export_transactions_reports_path(format: :csv, period_type: :monthly)
    assert_response :success

    csv = CSV.parse(response.body, headers: true)

    # Verify Headers
    assert_includes csv.headers, "Subcategory"

    # Verify Rows
    parent_row = csv.find { |r| r["Category"] == "Parent Cat" && r["Subcategory"] == "(Total)" }
    child_row = csv.find { |r| r["Category"] == "Parent Cat" && r["Subcategory"] == "Child Cat" }

    assert_not_nil parent_row, "Parent aggregation row missing"
    assert_not_nil child_row, "Child subcategory row missing"

    # Verify Amounts
    assert_equal "150.0", parent_row["Amount"] # 100 + 50
    assert_equal "50.0", child_row["Amount"]
  end
end
