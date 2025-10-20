require "test_helper"

class MessagesControllerTest < ActionDispatch::IntegrationTest
  setup do
    sign_in @user = users(:family_admin)
    @chat = @user.chats.first
  end

  test "can create a message" do
    post chat_messages_url(@chat), params: { message: { content: "Hello", ai_model: "gpt-4.1" } }

    assert_redirected_to chat_path(@chat, thinking: true)
  end

  test "keeps floating chat context when message is created from floating component" do
    post chat_messages_url(@chat, floating: true),
      params: { message: { content: "Hello from floating", ai_model: "gpt-4.1" } },
      headers: { "Turbo-Frame" => "floating_chat_content" }

    assert_response :success
    assert_select "turbo-frame#floating_chat_content"
  end

  test "returns validation errors for floating chat when content blank" do
    post chat_messages_url(@chat, floating: true),
      params: { message: { content: "", ai_model: "gpt-4.1" } },
      headers: { "Turbo-Frame" => "floating_chat_content" }

    assert_response :unprocessable_entity
    assert_select "turbo-frame#floating_chat_content" do
      assert_select "p", text: /can't be blank/i
    end
  end

  test "returns validation errors for html chat when content blank" do
    post chat_messages_url(@chat),
      params: { message: { content: "", ai_model: "gpt-4.1" } }

    assert_response :unprocessable_entity
    assert_select "p", text: /can't be blank/i
  end

  test "cannot create a message if AI is disabled" do
    @user.update!(ai_enabled: false)

    post chat_messages_url(@chat), params: { message: { content: "Hello", ai_model: "gpt-4.1" } }

    assert_response :forbidden
  end
end
