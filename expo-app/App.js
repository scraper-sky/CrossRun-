import React from "react";
import { StatusBar } from "expo-status-bar";
import { View, StyleSheet } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import CrossRunDom from "./src/CrossRunDom";

const storageGet = async (key) => AsyncStorage.getItem(key);
const storageSet = async (key, value) => AsyncStorage.setItem(key, value);
// light: a word solved, medium: a streak, success: a crossword cleared, error: the run ended
const haptic = async (kind) => {
  try {
    if (kind === "success") await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    else if (kind === "error") await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    else if (kind === "medium") await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch (e) {}
};

export default function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <StatusBar style="light" />
        <View style={styles.fill}>
          <CrossRunDom
            storageGet={storageGet}
            storageSet={storageSet}
            haptic={haptic}
            dom={{
              bounces: false,
              scrollEnabled: true,
              // let the game raise the keyboard itself when a level starts,
              // and drop the up/down/Done bar above it
              keyboardDisplayRequiresUserAction: false,
              hideKeyboardAccessoryView: true,
              // web audio and the sound effects must not wait for a media gesture
              mediaPlaybackRequiresUserAction: false,
              allowsInlineMediaPlayback: true,
              automaticallyAdjustContentInsets: false,
              style: { flex: 1, backgroundColor: "#5C3B22" },
            }}
          />
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#5C3B22" },
  fill: { flex: 1, backgroundColor: "#5C3B22" },
});
