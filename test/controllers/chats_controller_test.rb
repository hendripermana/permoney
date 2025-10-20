require "test_helper"

class ChatsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @user = users(:family_admin)
    @family = families(:dylan_family)
    sign_in @user
  end

  test "gets index" do
    get chats_url
    assert_response :success
  end

  test "creates chat" do
    assert_difference("Chat.count") do
      post chats_url, params: { chat: { content: "Hello", ai_model: "gpt-4.1" } }
    end

    assert_redirected_to chat_path(Chat.order(created_at: :desc).first, thinking: true)
  end

  test "creates chat for floating chat component" do
    assert_difference("Chat.count") do
      post chats_url(floating: true),
        params: { chat: { content: "Hello from floating", ai_model: "gpt-4.1" } },
        headers: { "Turbo-Frame" => "floating_chat_content" }
    end

    assert_response :success
    assert_select "turbo-frame#floating_chat_content"
  end

  test "renders floating new chat form within turbo frame" do
    get new_chat_url(floating: true), headers: { "Turbo-Frame" => "floating_chat_content" }

    assert_response :success
    assert_select "turbo-frame#floating_chat_content"
  end

  test "renders floating chat within turbo frame" do
    chat = chats(:one)

    get chat_url(chat, floating: true), headers: { "Turbo-Frame" => "floating_chat_content" }

    assert_response :success
    assert_select "turbo-frame#floating_chat_content"
  end

  test "shows chat" do
    get chat_url(chats(:one))
    assert_response :success
  end

  test "destroys chat" do
    assert_difference("Chat.count", -1) do
      delete chat_url(chats(:one))
    end

    assert_redirected_to chats_url
  end

  test "should not allow access to other user's chats" do
    other_user = users(:family_member)
    other_chat = Chat.create!(user: other_user, title: "Other User's Chat")

    get chat_url(other_chat)
    assert_response :not_found

    delete chat_url(other_chat)
    assert_response :not_found
  end
end
