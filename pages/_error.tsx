import type { NextPageContext } from "next";

function ErrorPage({ statusCode }: { statusCode: number }) {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", textAlign: "center", padding: "100px 20px" }}>
      <h1 style={{ fontSize: 48, margin: 0 }}>{statusCode}</h1>
      <p style={{ color: "#666", marginTop: 8 }}>
        {statusCode === 404 ? "This page could not be found." : "An error occurred."}
      </p>
    </div>
  );
}

ErrorPage.getInitialProps = ({ res, err }: NextPageContext) => {
  const statusCode = res ? res.statusCode : err ? err.statusCode : 404;
  return { statusCode: statusCode ?? 500 };
};

export default ErrorPage;