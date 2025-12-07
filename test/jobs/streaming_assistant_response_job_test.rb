# frozen_string_literal: true

require "test_helper"

class StreamingAssistantResponseJobTest < ActiveJob::TestCase
  test "completes with fallback content when no deltas stream" do
    message = messages(:chat1_user)

    Assistant.any_instance.expects(:respond_streaming).with(message).returns(nil)

    assert_difference "AssistantMessage.count", +1 do
      StreamingAssistantResponseJob.perform_now(message.id)
    end

    assistant_message = AssistantMessage.order(:created_at).last
    assert_equal "complete", assistant_message.status
    assert_not_predicate assistant_message.content, :blank?
  end
end
