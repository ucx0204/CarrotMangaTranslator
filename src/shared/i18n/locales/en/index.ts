import common from "./common.json";
import components from "./components.json";
import main from "./main.json";
import manualRedactionReview from "./manualRedactionReview.json";
import renderer from "./renderer.json";

export default {
  common,
  components: {
    ...components,
    manualRedaction: {
      ...components.manualRedaction,
      ...manualRedactionReview,
    },
  },
  main,
  renderer,
};
