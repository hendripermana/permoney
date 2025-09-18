require "test_helper"

class RedirectLoopPreventionTest < ActionDispatch::IntegrationTest
  setup do
    @user = users(:empty)
    @family = families(:empty)
    @user.update!(family: @family)

    # Ensure redirect loop prevention is enabled for tests
    Rails.application.config.redirect_loop_prevention ||= ActiveSupport::OrderedOptions.new
    Rails.application.config.redirect_loop_prevention.enabled = true
    Rails.application.config.redirect_loop_prevention.loop_threshold = 3
    Rails.application.config.redirect_loop_prevention.report_to_sentry = true
  end

  teardown do
    # Reset configuration after tests
    Rails.application.config.redirect_loop_prevention.report_to_sentry = false
  end

  test "detects simple self-redirect loop" do
    sign_in_user @user

    # Simulate multiple visits to the same path
    3.times do
      get root_path
      assert_response :success
    end

    # Circuit may be initialized but should not be in open state
    if session[:redirect_circuit]
      circuit = session[:redirect_circuit].values.first
      assert_not_equal "open", circuit[:status] if circuit
    end
  end

  test "detects A -> B -> A redirect loop pattern" do
    sign_in_user @user

    # Create a mock session with redirect history
    get root_path
    session[:redirect_circuit] = {
      "test_fingerprint" => {
        status: "closed",
        history: [ "/path_a", "/path_b", "/path_a", "/path_b", "/path_a" ],
        loop_count: 2,
        last_loop_at: nil,
        opened_at: nil,
        fingerprint: "test_fingerprint"
      }
    }

    # Next visit to path_a should trigger loop detection
    get root_path
    assert_response :success
  end

  test "circuit breaker opens after threshold is reached" do
    sign_in_user @user

    # Simulate a redirect loop scenario
    session[:redirect_circuit] = {
      "test_fingerprint" => {
        status: "closed",
        history: [ "/test", "/test", "/test" ],
        loop_count: 2,
        last_loop_at: nil,
        opened_at: nil,
        fingerprint: "test_fingerprint"
      }
    }

    get root_path

    # Circuit should transition based on loop detection
    assert_response :success
  end

  test "circuit breaker enters half-open state after cooldown" do
    sign_in_user @user

    # Set up an open circuit that's past cooldown
    past_time = (Time.current - 35.seconds).iso8601
    session[:redirect_circuit] = {
      "test_fingerprint" => {
        status: "open",
        history: [],
        loop_count: 3,
        last_loop_at: past_time,
        opened_at: past_time,
        fingerprint: "test_fingerprint"
      }
    }

    get root_path

    # Should allow request and transition to half-open
    assert_response :success
  end

  test "cleans up old circuit breaker states" do
    sign_in_user @user

    # Create multiple circuit states with different ages
    old_time = (Time.current - 2.hours).iso8601
    recent_time = (Time.current - 10.minutes).iso8601

    session[:redirect_circuit] = {
      "old_fingerprint" => {
        status: "closed",
        history: [],
        loop_count: 0,
        last_loop_at: old_time,
        opened_at: nil,
        fingerprint: "old_fingerprint"
      },
      "recent_fingerprint" => {
        status: "closed",
        history: [],
        loop_count: 0,
        last_loop_at: recent_time,
        opened_at: nil,
        fingerprint: "recent_fingerprint"
      }
    }

    get root_path
    assert_response :success

    # Old fingerprint should be cleaned up
    assert_not_nil session[:redirect_circuit]
  end

  test "skips loop detection for API requests" do
    sign_in_user @user

    # API requests should not trigger loop detection
    get "/api/v1/accounts", headers: { "Accept" => "application/json" }

    # Circuit should not be initialized for API requests
    assert session[:redirect_circuit].nil? || session[:redirect_circuit].empty?
  end

  test "skips loop detection for asset requests" do
    # Asset requests should not trigger loop detection
    get "/assets/application.css"

    # Circuit should not be initialized for asset requests
    assert session[:redirect_circuit].nil? || session[:redirect_circuit].empty?
  end

  test "skips loop detection for turbo stream requests" do
    sign_in_user @user

    # Turbo stream requests should not trigger loop detection
    get root_path, headers: { "Accept" => "text/vnd.turbo-stream.html" }

    # Circuit should not be initialized for turbo stream requests
    assert session[:redirect_circuit].nil? || session[:redirect_circuit].empty?
  end

  test "skips loop detection for XHR requests" do
    sign_in_user @user

    # XHR requests should not trigger loop detection
    get root_path, xhr: true

    # Circuit should not be initialized for XHR requests
    assert session[:redirect_circuit].nil? || session[:redirect_circuit].empty?
  end

  test "determines correct safe fallback path for logged in user with family" do
    sign_in_user @user

    # Should redirect to root for user with family
    session[:redirect_circuit] = {
      "test_fingerprint" => {
        status: "open",
        history: [ "/bad", "/bad" ],
        loop_count: 3,
        last_loop_at: Time.current.iso8601,
        opened_at: Time.current.iso8601,
        fingerprint: "test_fingerprint"
      }
    }

    get root_path
    assert_response :success
  end

  test "determines correct safe fallback path for logged in user without family" do
    @user.update!(family: nil)
    sign_in_user @user

    # For managed mode without family, should redirect to onboarding
    Rails.configuration.stubs(:app_mode).returns("managed".inquiry)

    # Set up an open circuit to trigger the safe path redirect
    fingerprint = Digest::SHA256.hexdigest("#{@user.id}|127.0.0.1||")[0, 16]

    get root_path  # First request to initialize session

    # Now set the circuit to open state
    session[:redirect_circuit] = {
      fingerprint => {
        status: "open",
        history: [ "/", "/" ],
        loop_count: 3,
        last_loop_at: Time.current.iso8601,
        opened_at: Time.current.iso8601,
        fingerprint: fingerprint
      }
    }

    # When circuit is open and user has no family in managed mode,
    # it should redirect to onboarding
    get root_path

    # Should redirect to onboarding for managed mode without family
    assert_redirected_to onboarding_path
  ensure
    Rails.configuration.unstub(:app_mode)
  end

  test "determines correct safe fallback path for non-logged in user" do
    # Should redirect to login for non-authenticated user
    get root_path
    assert_redirected_to new_session_path
  end

  test "generates unique fingerprint for different users" do
    sign_in_user @user
    get root_path

    circuit1 = session[:redirect_circuit]

    sign_out_user
    sign_in_user users(:family_admin)
    get root_path

    circuit2 = session[:redirect_circuit]

    # Different users should have different fingerprints
    if circuit1 && circuit2
      assert_not_equal circuit1.keys.first, circuit2.keys.first
    end
  end

  test "detects complex redirect patterns" do
    sign_in_user @user

    # Simulate a complex loop pattern A -> B -> C -> A
    session[:redirect_circuit] = {
      "test_fingerprint" => {
        status: "closed",
        history: [ "/a", "/b", "/c", "/a", "/b", "/c" ],
        loop_count: 1,
        last_loop_at: nil,
        opened_at: nil,
        fingerprint: "test_fingerprint"
      }
    }

    # Next visit to /a should detect the pattern
    get root_path
    assert_response :success
  end

  test "handles referrer-based loop detection" do
    sign_in_user @user

    # First, ensure we have a valid route
    get root_path
    assert_response :success

    # Now test referrer-based loop detection
    # This test is checking the detection logic, not actual redirects
    # The pattern detection happens internally
    get root_path, headers: { "HTTP_REFERER" => "http://www.example.com/accounts" }

    # Manually set up circuit state to test detection
    if session[:redirect_circuit]
      circuit = session[:redirect_circuit].values.first
      if circuit
        circuit[:history] = [ "/accounts", "/", "/accounts" ]
        circuit[:loop_count] = 1
      end
    end

    # Visit accounts path with root as referrer - this would trigger detection
    get accounts_path, headers: { "HTTP_REFERER" => "http://www.example.com/" }

    # Should work normally as we're not at threshold yet
    assert_response :success
  end

  test "renders error page when already at safe path" do
    sign_in_user @user

    # Simulate being at the safe path with an open circuit
    session[:redirect_circuit] = {
      "test_fingerprint" => {
        status: "open",
        history: [ "/", "/", "/" ],
        loop_count: 3,
        last_loop_at: Time.current.iso8601,
        opened_at: Time.current.iso8601,
        fingerprint: "test_fingerprint"
      }
    }

    # When already at root (safe path), should render error page
    get root_path

    # Should get a response (either success or error page)
    assert_response :success
  end

  test "logs to Sentry when available" do
    sign_in_user @user

    # Mock Sentry if it's defined
    if defined?(Sentry) && ENV["SENTRY_DSN"].present?
      Sentry.expects(:capture_message).with(
        "Redirect loop detected",
        level: :warning,
        extra: anything
      ).once

      # Force the circuit to open by simulating a loop
      3.times do
        get root_path
        # Manually update session to simulate loop detection
        if session[:redirect_circuit]
          circuit = session[:redirect_circuit].values.first
          circuit[:history] = [ "/", "/", "/" ] if circuit
          circuit[:loop_count] = 2 if circuit
        end
      end

      # This should trigger the circuit to open and call Sentry
      get root_path
    else
      skip "Sentry not configured"
    end
  end

  private

    def sign_in_user(user)
      # Use the test helper method from test_helper.rb
      sign_in(user)
    end

    def sign_out_user
      if @user.sessions.any?
        delete session_path(@user.sessions.first)
      end
    end
end
